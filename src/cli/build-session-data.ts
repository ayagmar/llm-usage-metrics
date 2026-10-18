import { buildEventProjectLabels, toProjectKey } from '../aggregate/project-key.js';
import { aggregateSessions, aggregateSessionsByRepo } from '../session/aggregate-sessions.js';
import type { SessionRow } from '../session/session-row.js';
import { buildSessionTimeline } from '../session/session-timeline.js';
import { dedupeToolCalls } from '@ayagmar/agent-sessions';
import { getPeriodKey } from '../utils/time-buckets.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { getEventSessionKey, type UsageEvent } from '../domain/usage-event.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
  withPricingNotes,
} from './build-usage-event-dataset.js';
import {
  formatFailedLiveReads,
  formatLiveEventsNote,
  readLiveSessionEvents,
} from './read-live-session-events.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildSessionDataDeps,
  SessionCommandOptions,
  SessionDataResult,
} from './usage-data-contracts.js';
import { limitRows, parseTopRowsOption, resolveTopRowLimit } from './top-option.js';

const MAX_LISTED_TIMELINE_MATCHES = 10;
const LIVE_TIMELINE_SUBJECT = 'Tool calls and turns';

function normalizeSessionIdFilters(id: string[] | undefined): string[] | undefined {
  if (!id || id.length === 0) {
    return undefined;
  }

  const normalizedIds = id
    .flatMap((candidate) => candidate.split(','))
    .map((candidate) => candidate.trim().toLowerCase())
    .filter((candidate) => candidate.length > 0);

  if (normalizedIds.length === 0) {
    throw new Error('--id must contain at least one non-empty session id filter');
  }

  return [...new Set(normalizedIds)];
}

function validateTimelineOptions(options: SessionCommandOptions, hasIdFilters: boolean): void {
  if (!options.timeline) {
    return;
  }

  if (!hasIdFilters) {
    throw new Error('--timeline needs --id <session-id> naming one session');
  }

  if (options.top !== undefined) {
    throw new Error('--timeline shows every request; it cannot be combined with --top');
  }
}

/**
 * The one session `--id` names: the only match, or the only row whose id equals a filter
 * when several match. Otherwise an error listing what it matched.
 */
function requireOneTimelineSession(
  sessionRows: readonly SessionRow[],
  idFilters: readonly string[],
  timezone: string,
): SessionRow {
  const idText = idFilters.join(',');

  if (sessionRows.length === 0) {
    throw new Error(
      `--timeline found no session matching --id ${idText}. Run \`llm-usage session\` to list session ids, or widen --since/--until.`,
    );
  }

  const exactRows = sessionRows.filter((row) => idFilters.includes(row.sessionId.toLowerCase()));

  if (sessionRows.length > 1 && exactRows.length !== 1) {
    const listedRows = sessionRows.slice(0, MAX_LISTED_TIMELINE_MATCHES);
    const sourceWidth = Math.max(...listedRows.map((row) => row.source.length));
    const idWidth = Math.max(...listedRows.map((row) => row.sessionId.length));
    const listed = listedRows.map(
      (row) =>
        `  ${row.source.padEnd(sourceWidth)}  ${row.sessionId.padEnd(idWidth)}  ${getPeriodKey(row.lastActivity, 'daily', timezone)}`,
    );
    const unlisted = sessionRows.length - listed.length;

    throw new Error(
      [
        `--timeline needs exactly one session, but --id ${idText} matches ${sessionRows.length}:`,
        ...listed,
        ...(unlisted > 0 ? [`  and ${unlisted} more`] : []),
        'Pass more of the session id to --id, or narrow with --source.',
      ].join('\n'),
    );
  }

  return sessionRows.length === 1 ? sessionRows[0] : exactRows[0];
}

export async function buildSessionData(
  options: SessionCommandOptions,
  deps: BuildSessionDataDeps = {},
): Promise<SessionDataResult> {
  const idFilters = normalizeSessionIdFilters(options.id);

  if (idFilters && options.byRepo) {
    throw new Error('--id cannot be combined with --by-repo');
  }

  validateTimelineOptions(options, idFilters !== undefined);

  const top = parseTopRowsOption(options.top);
  const limit = resolveTopRowLimit(top, idFilters !== undefined);
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'session.dataset.total',
    () => buildUsageEventDataset(options, deps),
  );
  const pricingResult = await applyPricingToUsageEventDataset(dataset, deps, 'auto');
  const { pricedEvents, pricingOrigin, pricingWarning } = pricingResult;
  // From every event, as `projects` labels them, so a label does not depend on --top or --id.
  const projectLabels = buildEventProjectLabels(pricedEvents);
  // Only the shown rows carry `~`, so only their events explain it.
  const buildDiagnostics = (
    shownEvents: UsageEvent[],
    live: { warnings: string[]; notes: string[] } = { warnings: [], notes: [] },
  ) =>
    buildUsageDiagnostics({
      adaptersToParse: dataset.adaptersToParse,
      successfulParseResults: dataset.successfulParseResults,
      sourceFailures: dataset.sourceFailures,
      pricingOrigin,
      pricingWarning,
      warnings: [...dataset.warnings, ...live.warnings],
      notes: [...withPricingNotes(dataset.notes, shownEvents, pricingResult), ...live.notes],
      activeEnvOverrides: dataset.readEnvVarOverrides(),
      activeConfig: dataset.activeConfig,
      timezone: dataset.normalizedInputs.timezone,
      runtimeProfile: deps.runtimeProfile?.snapshot(),
    });

  if (options.byRepo) {
    const repoRows = measureRuntimeProfileStageSync(deps.runtimeProfile, 'session.aggregate', () =>
      aggregateSessionsByRepo(pricedEvents),
    );
    const limited = limitRows(repoRows, limit, 'repos');
    const shownRepos = new Set(limited.rows.map((row) => row.repoRoot));

    return {
      grouping: 'repo',
      rows: limited.rows,
      projectLabels,
      limitNote: limited.limitNote,
      diagnostics: buildDiagnostics(
        pricedEvents.filter((event) => shownRepos.has(toProjectKey(event.repoRoot))),
      ),
    };
  }

  const sessionRows = measureRuntimeProfileStageSync(deps.runtimeProfile, 'session.aggregate', () =>
    aggregateSessions(pricedEvents, { ids: idFilters }),
  );

  if (options.timeline && idFilters) {
    const session = requireOneTimelineSession(
      sessionRows,
      idFilters,
      dataset.normalizedInputs.timezone,
    );
    const sessionKey = getEventSessionKey(session);
    const sessionEvents = pricedEvents.filter((event) => getEventSessionKey(event) === sessionKey);
    // Tool calls come from every file of the session's source, as `tools` reads them, so a
    // call a resumed or forked transcript copied from its parent stays its parent's.
    const live = await measureRuntimeProfileStage(deps.runtimeProfile, 'session.read_live', () =>
      readLiveSessionEvents(dataset, {
        kinds: ['tool_call', 'message'],
        filePaths: new Set(
          [...dataset.parsedFiles, ...(dataset.ledger?.historyFiles ?? [])]
            .filter((file) => file.source === session.source)
            .map((file) => file.filePath),
        ),
      }),
    );
    const toolCalls = dedupeToolCalls(
      live.events.filter((event) => event.kind === 'tool_call'),
    ).filter((event) => getEventSessionKey(event) === sessionKey);
    // Messages carry no id that holds across copies (user turns have none), so they are the
    // session's messages, copied ones included.
    const messages = live.events.filter(
      (event) => event.kind === 'message' && getEventSessionKey(event) === sessionKey,
    );

    return {
      grouping: 'timeline',
      session,
      rows: buildSessionTimeline(sessionEvents, [...toolCalls, ...messages]),
      projectLabels,
      diagnostics: buildDiagnostics(sessionEvents, {
        warnings: formatFailedLiveReads(LIVE_TIMELINE_SUBJECT, live.failedFilePaths),
        notes: [formatLiveEventsNote(LIVE_TIMELINE_SUBJECT, dataset)],
      }),
    };
  }

  const limited = limitRows(sessionRows, limit, 'sessions');
  const shownSessions = new Set(limited.rows.map((row) => getEventSessionKey(row)));

  return {
    grouping: 'session',
    rows: limited.rows,
    projectLabels,
    limitNote: limited.limitNote,
    diagnostics: buildDiagnostics(
      pricedEvents.filter((event) => shownSessions.has(getEventSessionKey(event))),
    ),
  };
}
