import { toProjectKey } from '../aggregate/project-key.js';
import { computeActiveMs } from '@ayagmar/agent-sessions';
import { getEventSessionKey, normalizeOptionalModel } from '../domain/usage-event.js';
import type { UsageEvent } from '../domain/usage-event.js';
import type { UsageTotals } from '../domain/usage-report-row.js';
import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';
import type { SessionRepoRow, SessionRow } from './session-row.js';
import { addUsd } from '../utils/usd-math.js';

export type AggregateSessionsOptions = {
  ids?: string[];
};

/** Each session's repository root, as `getEventSessionKey` keys it: the first one its events record. */
export function mapSessionRepoRoots(events: Iterable<UsageEvent>): Map<string, string | undefined> {
  const repoRoots = new Map<string, string | undefined>();

  for (const event of events) {
    const key = getEventSessionKey(event);

    if (repoRoots.get(key) === undefined) {
      repoRoots.set(key, event.repoRoot);
    }
  }

  return repoRoots;
}

type SessionAccumulator = UsageTotals & {
  source: string;
  sessionId: string;
  firstActivity: string;
  lastActivity: string;
  timestampsMs: number[];
  eventCount: number;
  models: Set<string>;
};

type RepoAccumulator = UsageTotals & {
  repoRoot: string | undefined;
  firstActivity: string;
  lastActivity: string;
  sessionKeys: Set<string>;
  sources: Set<string>;
};

function createAccumulator(event: UsageEvent): SessionAccumulator {
  return {
    source: event.source,
    sessionId: event.sessionId,
    firstActivity: event.timestamp,
    lastActivity: event.timestamp,
    timestampsMs: [],
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
  accumulator.timestampsMs.push(Date.parse(event.timestamp));

  if (event.timestamp < accumulator.firstActivity) {
    accumulator.firstActivity = event.timestamp;
  }

  if (event.timestamp > accumulator.lastActivity) {
    accumulator.lastActivity = event.timestamp;
  }

  const model = normalizeOptionalModel(event.model);

  if (model) {
    accumulator.models.add(model);
  }
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

function toSessionRow(accumulator: SessionAccumulator, repoRoot: string | undefined): SessionRow {
  return {
    rowType: 'session',
    source: accumulator.source,
    sessionId: accumulator.sessionId,
    repoRoot,
    firstActivity: accumulator.firstActivity,
    lastActivity: accumulator.lastActivity,
    durationMs: Date.parse(accumulator.lastActivity) - Date.parse(accumulator.firstActivity),
    activeMs: computeActiveMs(accumulator.timestampsMs),
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

    const key = getEventSessionKey(event);
    const accumulator = sessions.get(key) ?? createAccumulator(event);
    addEventToAccumulator(accumulator, event);
    sessions.set(key, accumulator);
  }

  const repoRoots = mapSessionRepoRoots(events);

  return [...sessions]
    .map(([key, accumulator]) => toSessionRow(accumulator, repoRoots.get(key)))
    .sort(compareSessionRows);
}

function createRepoAccumulator(repoRoot: string | undefined, event: UsageEvent): RepoAccumulator {
  return {
    repoRoot,
    firstActivity: event.timestamp,
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
  accumulator.sessionKeys.add(getEventSessionKey(event));
  accumulator.sources.add(event.source);
  addEventUsage(accumulator, event);

  if (event.timestamp < accumulator.firstActivity) {
    accumulator.firstActivity = event.timestamp;
  }

  if (event.timestamp > accumulator.lastActivity) {
    accumulator.lastActivity = event.timestamp;
  }
}

function toRepoRow(accumulator: RepoAccumulator): SessionRepoRow {
  return {
    rowType: 'repo',
    repoRoot: accumulator.repoRoot,
    sessionCount: accumulator.sessionKeys.size,
    firstActivity: accumulator.firstActivity,
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

export function aggregateSessionsByRepo(events: readonly UsageEvent[]): SessionRepoRow[] {
  const repos = new Map<string | undefined, RepoAccumulator>();

  for (const event of events) {
    // Keyed like `projects`, so `/x/app` and `/x/app/` are one row.
    const key = toProjectKey(event.repoRoot);
    const accumulator = repos.get(key) ?? createRepoAccumulator(key, event);
    addEventToRepoAccumulator(accumulator, event);
    repos.set(key, accumulator);
  }

  return [...repos.values()].map(toRepoRow).sort(compareRepoRows);
}
