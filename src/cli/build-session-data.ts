import { aggregateSessions, aggregateSessionsByRepo } from '../session/aggregate-sessions.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildSessionDataDeps,
  SessionCommandOptions,
  SessionDataResult,
} from './usage-data-contracts.js';

const DEFAULT_SESSION_TOP = 20;

function parseSessionTopOption(top: string | undefined): number | undefined {
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

function resolveSessionRowLimit(
  top: number | undefined,
  hasIdFilters: boolean,
): number | undefined {
  if (top !== undefined) {
    return top === 0 ? undefined : top;
  }

  return hasIdFilters ? undefined : DEFAULT_SESSION_TOP;
}

function limitRows<Row>(
  rows: Row[],
  limit: number | undefined,
  rowNoun: 'sessions' | 'repos',
): { rows: Row[]; limitNote?: string } {
  if (limit === undefined || rows.length <= limit) {
    return { rows };
  }

  return {
    rows: rows.slice(0, limit),
    limitNote: `Showing top ${limit} of ${rows.length} ${rowNoun} by cost. Use --top 0 for all.`,
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
  const { pricedEvents, pricingOrigin, pricingWarning } = await applyPricingToUsageEventDataset(
    dataset,
    deps,
    'auto',
  );
  const aggregateOptions = {
    timezone: dataset.normalizedInputs.timezone,
    since: options.since,
    until: options.until,
  };
  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  if (options.byRepo) {
    const repoRows = measureRuntimeProfileStageSync(deps.runtimeProfile, 'session.aggregate', () =>
      aggregateSessionsByRepo(pricedEvents, aggregateOptions),
    );
    const limited = limitRows(repoRows, limit, 'repos');

    return {
      grouping: 'repo',
      rows: limited.rows,
      limitNote: limited.limitNote,
      diagnostics,
    };
  }

  const sessionRows = measureRuntimeProfileStageSync(deps.runtimeProfile, 'session.aggregate', () =>
    aggregateSessions(pricedEvents, { ...aggregateOptions, ids: idFilters }),
  );
  const limited = limitRows(sessionRows, limit, 'sessions');

  return {
    grouping: 'session',
    rows: limited.rows,
    limitNote: limited.limitNote,
    diagnostics,
  };
}
