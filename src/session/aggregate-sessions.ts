import type { UsageEvent } from '../domain/usage-event.js';
import type { UsageTotals } from '../domain/usage-report-row.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getPeriodKey } from '../utils/time-buckets.js';
import type { SessionRepoRow, SessionRow } from './session-row.js';

export type AggregateSessionsOptions = {
  timezone?: string;
  since?: string;
  until?: string;
  top?: number;
  ids?: string[];
};

export type AggregateSessionsByRepoOptions = Omit<AggregateSessionsOptions, 'ids' | 'top'>;

type SessionAccumulator = UsageTotals & {
  source: string;
  sessionId: string;
  repoRoot: string | undefined;
  firstActivity: string;
  lastActivity: string;
  eventCount: number;
  models: Set<string>;
};

type RepoAccumulator = UsageTotals & {
  repoRoot: string | undefined;
  lastActivity: string;
  sessionKeys: Set<string>;
  sources: Set<string>;
};

const USD_PRECISION_SCALE = 1_000_000_000_000;

function addUsd(left: number, right: number): number {
  return Math.round((left + right) * USD_PRECISION_SCALE) / USD_PRECISION_SCALE;
}

function createAccumulator(event: UsageEvent): SessionAccumulator {
  return {
    source: event.source,
    sessionId: event.sessionId,
    repoRoot: undefined,
    firstActivity: event.timestamp,
    lastActivity: event.timestamp,
    eventCount: 0,
    models: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

function normalizeModel(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }

  const normalized = model.trim().toLowerCase();
  return normalized || undefined;
}

function addEventUsage(totals: UsageTotals, event: UsageEvent): void {
  totals.inputTokens += event.inputTokens;
  totals.outputTokens += event.outputTokens;
  totals.reasoningTokens += event.reasoningTokens;
  totals.cacheReadTokens += event.cacheReadTokens;
  totals.cacheWriteTokens += event.cacheWriteTokens;
  totals.totalTokens += event.totalTokens;

  if (event.costUsd === undefined) {
    totals.costIncomplete = true;
  } else {
    totals.costUsd = addUsd(totals.costUsd ?? 0, event.costUsd);
  }
}

function addEventToAccumulator(accumulator: SessionAccumulator, event: UsageEvent): void {
  accumulator.eventCount++;
  addEventUsage(accumulator, event);

  accumulator.repoRoot ??= event.repoRoot;

  if (event.timestamp < accumulator.firstActivity) {
    accumulator.firstActivity = event.timestamp;
  }

  if (event.timestamp > accumulator.lastActivity) {
    accumulator.lastActivity = event.timestamp;
  }

  const model = normalizeModel(event.model);

  if (model) {
    accumulator.models.add(model);
  }
}

function getSessionKey(event: UsageEvent): string {
  return `${event.source}\0${event.sessionId}`;
}

function isEventWithinDateRange(
  event: UsageEvent,
  options: AggregateSessionsByRepoOptions,
): boolean {
  if (!options.since && !options.until) {
    return true;
  }

  const eventDate = getPeriodKey(event.timestamp, 'daily', options.timezone ?? 'UTC');

  if (options.since && eventDate < options.since) {
    return false;
  }

  if (options.until && eventDate > options.until) {
    return false;
  }

  return true;
}

function matchesSessionIdFilters(sessionId: string, idFilters: readonly string[]): boolean {
  const normalizedSessionId = sessionId.toLowerCase();
  return idFilters.some((idFilter) => normalizedSessionId.includes(idFilter));
}

function compareByCostThenLastActivity(
  left: UsageTotals & { lastActivity: string },
  right: UsageTotals & { lastActivity: string },
): number {
  if (left.costUsd !== undefined && right.costUsd === undefined) {
    return -1;
  }

  if (left.costUsd === undefined && right.costUsd !== undefined) {
    return 1;
  }

  if (left.costUsd !== undefined && right.costUsd !== undefined && left.costUsd !== right.costUsd) {
    return right.costUsd - left.costUsd;
  }

  return compareByCodePoint(right.lastActivity, left.lastActivity);
}

function compareSessionRows(left: SessionRow, right: SessionRow): number {
  const byCostThenActivity = compareByCostThenLastActivity(left, right);

  if (byCostThenActivity !== 0) {
    return byCostThenActivity;
  }

  return compareByCodePoint(left.sessionId, right.sessionId);
}

function compareRepoRows(left: SessionRepoRow, right: SessionRepoRow): number {
  const byCostThenActivity = compareByCostThenLastActivity(left, right);

  if (byCostThenActivity !== 0) {
    return byCostThenActivity;
  }

  return compareByCodePoint(left.repoRoot ?? '', right.repoRoot ?? '');
}

function toSessionRow(accumulator: SessionAccumulator): SessionRow {
  return {
    rowType: 'session',
    source: accumulator.source,
    sessionId: accumulator.sessionId,
    repoRoot: accumulator.repoRoot,
    firstActivity: accumulator.firstActivity,
    lastActivity: accumulator.lastActivity,
    eventCount: accumulator.eventCount,
    models: [...accumulator.models].sort(compareByCodePoint),
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    reasoningTokens: accumulator.reasoningTokens,
    cacheReadTokens: accumulator.cacheReadTokens,
    cacheWriteTokens: accumulator.cacheWriteTokens,
    totalTokens: accumulator.totalTokens,
    costUsd: accumulator.costUsd,
    costIncomplete: accumulator.costIncomplete,
  };
}

export function aggregateSessions(
  events: readonly UsageEvent[],
  options: AggregateSessionsOptions = {},
): SessionRow[] {
  const idFilters = options.ids?.length
    ? options.ids.map((idFilter) => idFilter.toLowerCase())
    : undefined;
  const sessions = new Map<string, SessionAccumulator>();

  for (const event of events) {
    if (idFilters && !matchesSessionIdFilters(event.sessionId, idFilters)) {
      continue;
    }

    if (!isEventWithinDateRange(event, options)) {
      continue;
    }

    const key = getSessionKey(event);
    const accumulator = sessions.get(key) ?? createAccumulator(event);
    addEventToAccumulator(accumulator, event);
    sessions.set(key, accumulator);
  }

  const rows = [...sessions.values()].map(toSessionRow).sort(compareSessionRows);

  return options.top === undefined ? rows : rows.slice(0, options.top);
}

function createRepoAccumulator(event: UsageEvent): RepoAccumulator {
  return {
    repoRoot: event.repoRoot,
    lastActivity: event.timestamp,
    sessionKeys: new Set(),
    sources: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

function addEventToRepoAccumulator(accumulator: RepoAccumulator, event: UsageEvent): void {
  accumulator.sessionKeys.add(getSessionKey(event));
  accumulator.sources.add(event.source);
  addEventUsage(accumulator, event);

  if (event.timestamp > accumulator.lastActivity) {
    accumulator.lastActivity = event.timestamp;
  }
}

function toRepoRow(accumulator: RepoAccumulator): SessionRepoRow {
  return {
    rowType: 'repo',
    repoRoot: accumulator.repoRoot,
    sessionCount: accumulator.sessionKeys.size,
    lastActivity: accumulator.lastActivity,
    sources: [...accumulator.sources].sort(compareByCodePoint),
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    reasoningTokens: accumulator.reasoningTokens,
    cacheReadTokens: accumulator.cacheReadTokens,
    cacheWriteTokens: accumulator.cacheWriteTokens,
    totalTokens: accumulator.totalTokens,
    costUsd: accumulator.costUsd,
    costIncomplete: accumulator.costIncomplete,
  };
}

export function aggregateSessionsByRepo(
  events: readonly UsageEvent[],
  options: AggregateSessionsByRepoOptions = {},
): SessionRepoRow[] {
  const repos = new Map<string, RepoAccumulator>();

  for (const event of events) {
    if (!isEventWithinDateRange(event, options)) {
      continue;
    }

    const key = event.repoRoot ?? '';
    const accumulator = repos.get(key) ?? createRepoAccumulator(event);
    addEventToRepoAccumulator(accumulator, event);
    repos.set(key, accumulator);
  }

  return [...repos.values()].map(toRepoRow).sort(compareRepoRows);
}
