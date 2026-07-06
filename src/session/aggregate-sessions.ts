import type { UsageEvent } from '../domain/usage-event.js';
import type { UsageTotals } from '../domain/usage-report-row.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getPeriodKey } from '../utils/time-buckets.js';
import type { SessionRow } from './session-row.js';

export type AggregateSessionsOptions = {
  timezone?: string;
  since?: string;
  until?: string;
  top?: number;
};

type SessionAccumulator = UsageTotals & {
  source: string;
  sessionId: string;
  firstActivity: string;
  lastActivity: string;
  eventCount: number;
  models: Set<string>;
};

const USD_PRECISION_SCALE = 1_000_000_000_000;

function addUsd(left: number, right: number): number {
  return Math.round((left + right) * USD_PRECISION_SCALE) / USD_PRECISION_SCALE;
}

function createAccumulator(event: UsageEvent): SessionAccumulator {
  return {
    source: event.source,
    sessionId: event.sessionId,
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

function addEventToAccumulator(accumulator: SessionAccumulator, event: UsageEvent): void {
  accumulator.eventCount++;
  accumulator.inputTokens += event.inputTokens;
  accumulator.outputTokens += event.outputTokens;
  accumulator.reasoningTokens += event.reasoningTokens;
  accumulator.cacheReadTokens += event.cacheReadTokens;
  accumulator.cacheWriteTokens += event.cacheWriteTokens;
  accumulator.totalTokens += event.totalTokens;

  if (event.timestamp < accumulator.firstActivity) {
    accumulator.firstActivity = event.timestamp;
  }

  if (event.timestamp > accumulator.lastActivity) {
    accumulator.lastActivity = event.timestamp;
  }

  if (event.costUsd === undefined) {
    accumulator.costIncomplete = true;
  } else {
    accumulator.costUsd = addUsd(accumulator.costUsd ?? 0, event.costUsd);
  }

  const model = normalizeModel(event.model);

  if (model) {
    accumulator.models.add(model);
  }
}

function getSessionKey(event: UsageEvent): string {
  return `${event.source}\0${event.sessionId}`;
}

function isEventWithinDateRange(event: UsageEvent, options: AggregateSessionsOptions): boolean {
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

function compareSessionRows(left: SessionRow, right: SessionRow): number {
  if (left.costUsd !== undefined && right.costUsd === undefined) {
    return -1;
  }

  if (left.costUsd === undefined && right.costUsd !== undefined) {
    return 1;
  }

  if (left.costUsd !== undefined && right.costUsd !== undefined && left.costUsd !== right.costUsd) {
    return right.costUsd - left.costUsd;
  }

  if (left.lastActivity !== right.lastActivity) {
    return compareByCodePoint(right.lastActivity, left.lastActivity);
  }

  return compareByCodePoint(left.sessionId, right.sessionId);
}

function toSessionRow(accumulator: SessionAccumulator): SessionRow {
  return {
    rowType: 'session',
    source: accumulator.source,
    sessionId: accumulator.sessionId,
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
  const sessions = new Map<string, SessionAccumulator>();

  for (const event of events) {
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
