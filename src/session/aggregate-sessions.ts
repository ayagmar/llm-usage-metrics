import { toParentProjectKey, toProjectKey } from '../aggregate/project-key.js';
import { computeActiveMs, getEventSessionKey } from '@ayagmar/agent-sessions';
import type { UsageEvent } from '../domain/usage-event.js';
import type { UsageTotals } from '../domain/usage-report-row.js';
import { compareByCodePoint, normalizeOptionalModel } from '@ayagmar/agent-sessions/internal';
import type { SessionRepoRow, SessionRow } from './session-row.js';
import { addUsd } from '../utils/usd-math.js';

export type AggregateSessionsOptions = {
  ids?: string[];
};

/**
 * Each session's repository root, as `getEventSessionKey` keys it: the one its earliest event
 * with a root records (the smaller root on a tie), or undefined when none records one.
 */
export function mapSessionRepoRoots(events: Iterable<UsageEvent>): Map<string, string | undefined> {
  const earliest = new Map<string, { repoRoot?: string; timestamp?: string }>();
  // A session's events mostly come in a run, so the previous event's entry is usually it.
  let previous: UsageEvent | undefined;
  let entry: { repoRoot?: string; timestamp?: string } = {};

  for (const event of events) {
    if (previous?.sessionId !== event.sessionId || previous.source !== event.source) {
      const key = getEventSessionKey(event);
      entry = earliest.get(key) ?? {};
      earliest.set(key, entry);
    }

    previous = event;
    const repoRoot = event.repoRoot;

    if (
      repoRoot !== undefined &&
      (entry.repoRoot === undefined ||
        entry.timestamp === undefined ||
        event.timestamp < entry.timestamp ||
        (event.timestamp === entry.timestamp && compareByCodePoint(repoRoot, entry.repoRoot) < 0))
    ) {
      entry.repoRoot = repoRoot;
      entry.timestamp = event.timestamp;
    }
  }

  return new Map([...earliest].map(([key, { repoRoot }]) => [key, repoRoot]));
}

/**
 * Moves usage logged below its session's root to the project it belongs to. A session's root
 * is the project key of its earliest event (`mapSessionRepoRoots`). An event at or below it
 * goes to the nearest directory, from its own up to that root, where some session in `events`
 * started, so a session that `cd`s into a subdirectory stays one project, and one started in
 * a parent folder keeps the repositories other sessions started in. An event outside its
 * session's root keeps its own. Run it over every event a report reads, before any window or
 * `--repo` filter, so a project does not depend on them.
 */
export function attributeEventsToSessionRoots(
  eventLists: readonly (readonly UsageEvent[])[],
): UsageEvent[][] {
  // Roots repeat across many events: fold each distinct one once.
  const projectKeys = new Map<string, string | undefined>();
  const projectKeyOf = (repoRoot: string): string | undefined => {
    let key = projectKeys.get(repoRoot);

    if (key === undefined && !projectKeys.has(repoRoot)) {
      key = toProjectKey(repoRoot);
      projectKeys.set(repoRoot, key);
    }

    return key;
  };
  const sessionRoots = new Map<string, string | undefined>();

  for (const [sessionKey, repoRoot] of mapSessionRepoRoots(eventLists.flat())) {
    sessionRoots.set(sessionKey, repoRoot === undefined ? undefined : projectKeyOf(repoRoot));
  }

  const rootKeys = new Set(sessionRoots.values());
  // Per session root, each project key below it and the project it moves to.
  const attributedKeys = new Map<string, Map<string, string>>();

  const attribute = (key: string, sessionRoot: string): string => {
    let nearest: string | undefined;

    for (let candidate: string | undefined = key; candidate !== undefined;) {
      if (nearest === undefined && rootKeys.has(candidate)) {
        nearest = candidate;
      }

      if (candidate === sessionRoot) {
        return nearest ?? sessionRoot;
      }

      candidate = toParentProjectKey(candidate);
    }

    return key;
  };

  let previous: UsageEvent | undefined;
  let sessionRoot: string | undefined;

  return eventLists.map((events) =>
    events.map((event) => {
      if (previous?.sessionId !== event.sessionId || previous.source !== event.source) {
        sessionRoot = sessionRoots.get(getEventSessionKey(event));
      }

      previous = event;

      if (event.repoRoot === undefined) {
        return event;
      }

      const key = projectKeyOf(event.repoRoot);

      if (key === undefined || sessionRoot === undefined || key === sessionRoot) {
        return event;
      }

      let attributedByKey = attributedKeys.get(sessionRoot);

      if (attributedByKey === undefined) {
        attributedByKey = new Map();
        attributedKeys.set(sessionRoot, attributedByKey);
      }

      let attributed = attributedByKey.get(key);

      if (attributed === undefined) {
        attributed = attribute(key, sessionRoot);
        attributedByKey.set(key, attributed);
      }

      return attributed === key ? event : { ...event, repoRoot: attributed };
    }),
  );
}

type SessionAccumulator = UsageTotals & {
  source: string;
  sessionId: string;
  firstActivity: string;
  lastActivity: string;
  timestampsMs: number[];
  eventCount: number;
  models: Set<string>;
  costExplicitUsd?: number;
  costEstimatedUsd?: number;
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

  if (event.costUsd !== undefined) {
    if (event.costMode === 'explicit') {
      accumulator.costExplicitUsd = addUsd(accumulator.costExplicitUsd ?? 0, event.costUsd);
    } else {
      accumulator.costEstimatedUsd = addUsd(accumulator.costEstimatedUsd ?? 0, event.costUsd);
    }
  }
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
    ...(accumulator.costExplicitUsd !== undefined && {
      costExplicitUsd: accumulator.costExplicitUsd,
    }),
    ...(accumulator.costEstimatedUsd !== undefined && {
      costEstimatedUsd: accumulator.costEstimatedUsd,
    }),
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
