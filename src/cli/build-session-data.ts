import { buildEventProjectLabels, toProjectKey } from '../aggregate/project-key.js';
import { aggregateSessions, aggregateSessionsByRepo } from '../session/aggregate-sessions.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { getEventSessionKey, type UsageEvent } from '../domain/usage-event.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
  withPricingNotes,
} from './build-usage-event-dataset.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildSessionDataDeps,
  SessionCommandOptions,
  SessionDataResult,
} from './usage-data-contracts.js';

const DEFAULT_SESSION_TOP = 20;

export function parseSessionTopOption(top: string | undefined): number | undefined {
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

/** The first `limit` rows, already ranked by `rankedBy`, and a note when some are left out. */
export function limitRows<Row>(
  rows: Row[],
  limit: number | undefined,
  rowNoun: 'sessions' | 'repos',
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

export async function buildSessionData(
  options: SessionCommandOptions,
  deps: BuildSessionDataDeps = {},
): Promise<SessionDataResult> {
  const idFilters = normalizeSessionIdFilters(options.id);

  if (idFilters && options.byRepo) {
    throw new Error('--id cannot be combined with --by-repo');
  }

  const top = parseSessionTopOption(options.top);
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
  const buildDiagnostics = (shownEvents: UsageEvent[]) =>
    buildUsageDiagnostics({
      adaptersToParse: dataset.adaptersToParse,
      successfulParseResults: dataset.successfulParseResults,
      sourceFailures: dataset.sourceFailures,
      pricingOrigin,
      pricingWarning,
      warnings: dataset.warnings,
      notes: withPricingNotes(dataset.notes, shownEvents, pricingResult),
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
