import { buildEventProjectLabels, toProjectKey } from '../aggregate/project-key.js';
import { aggregateSessions, aggregateSessionsByRepo } from '../session/aggregate-sessions.js';
import type { SessionRow } from '../session/session-row.js';
import { buildSessionTimeline } from '../session/session-timeline.js';
import { countToolCallsOnce } from '../tools/aggregate-tools.js';
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

const DEFAULT_SESSION_TOP = 20;
const MAX_LISTED_TIMELINE_MATCHES = 10;
const LIVE_TIMELINE_SUBJECT = 'Tool calls and turns';

/** `--top N` where 0 shows every row; undefined when not passed. */
export function parseTopRowsOption(top: string | undefined): number | undefined {
  if (top === undefined) {
    return undefined;
  }

  const normalized = top.trim();
  const parsed = Number.parseInt(normalized, 10);

  if (!/^\d+$/u.test(normalized) || Number.isNaN(parsed)) {
    throw new Error('--top must be a non-negative integer (0 shows all rows)');
  }

  return parsed;
}

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

export function resolveSessionRowLimit(
  top: number | undefined,
  hasIdFilters: boolean,
): number | undefined {
  if (top !== undefined) {
    return top === 0 ? undefined : top;
  }

  return hasIdFilters ? undefined : DEFAULT_SESSION_TOP;
}

/** The first `limit` rows, with the note naming what --top left out. */
export function limitRows<Row>(
  rows: Row[],
  limit: number | undefined,
  rowNoun: string,
  rankedBy = 'cost',
): { rows: Row[]; limitNote?: string } {
  if (limit === undefined || rows.length <= limit) {
    return { rows };
  }

  return {
    rows: rows.slice(0, limit),
    limitNote: `Showing top ${limit} of ${rows.length} ${rowNoun} by ${rankedBy}. Use --top 0 for all.`,
  };
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

/** The one session `--id` names, or an error listing what it matched instead. */
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

  if (sessionRows.length > 1) {
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
        'Pass more of the session id to --id.',
      ].join('\n'),
    );
  }

  return sessionRows[0];
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
  const limit = resolveSessionRowLimit(top, idFilters !== undefined);
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'session.dataset.total',
    () => buildUsageEventDataset(options, deps),
  );
  const pricingResult = await applyPricingToUsageEventDataset(dataset, deps, 'auto');
  const { pricedEvents, pricingOrigin, pricingWarning } = pricingResult;
  // From every event, as `projects` labels them, so a label does not depend on --top or --id.
  const projectLabels = buildEventProjectLabels(pricedEvents);
  const aggregateOptions = {
    timezone: dataset.normalizedInputs.timezone,
    since: options.since,
    until: options.until,
  };
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
      aggregateSessionsByRepo(pricedEvents, aggregateOptions),
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
    aggregateSessions(pricedEvents, { ...aggregateOptions, ids: idFilters }),
  );

  if (options.timeline && idFilters) {
    const session = requireOneTimelineSession(
      sessionRows,
      idFilters,
      dataset.normalizedInputs.timezone,
    );
    const sessionKey = getEventSessionKey(session);
    const sessionEvents = pricedEvents.filter((event) => getEventSessionKey(event) === sessionKey);
    const live = await measureRuntimeProfileStage(deps.runtimeProfile, 'session.read_live', () =>
      readLiveSessionEvents(dataset, {
        kinds: ['tool_call', 'message'],
        sessionKeys: new Set([sessionKey]),
        // A session's live events are in the files that hold its usage.
        filePaths: new Set(
          dataset.parsedFiles
            .filter(
              (file) =>
                file.source === session.source && file.sessionIds.includes(session.sessionId),
            )
            .map((file) => file.filePath),
        ),
      }),
    );
    // Counted once across copies, as `tools` counts them.
    const toolCalls = countToolCallsOnce(live.events.filter((event) => event.kind === 'tool_call'));
    const messages = live.events.filter((event) => event.kind === 'message');

    return {
      grouping: 'timeline',
      session,
      rows: buildSessionTimeline(sessionEvents, [...toolCalls, ...messages]),
      projectLabels,
      diagnostics: buildDiagnostics(sessionEvents, {
        warnings: formatFailedLiveReads(LIVE_TIMELINE_SUBJECT, live.failedFilePaths),
        notes: [formatLiveEventsNote(LIVE_TIMELINE_SUBJECT)],
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
