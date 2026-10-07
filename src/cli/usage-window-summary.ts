import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import type { UsageEvent } from '../domain/usage-event.js';
import type { UsageReportRow, UsageTotals } from '../domain/usage-report-row.js';
import { getPeriodKey } from '../utils/time-buckets.js';
import { addUsd } from '../utils/usd-math.js';
import type { UsageWindowTotals } from './usage-data-contracts.js';

export type UsageDateWindow = {
  since: string;
  until: string;
};

export type UsageWindowSummary = {
  totals: UsageWindowTotals;
  sources: Map<string, UsageWindowTotals>;
};

export function isEventWithinWindow(
  event: UsageEvent,
  window: UsageDateWindow,
  timezone: string,
): boolean {
  const eventDate = getPeriodKey(event.timestamp, 'daily', timezone);
  return eventDate >= window.since && eventDate <= window.until;
}

export function createEmptyWindowTotals(): UsageWindowTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    events: 0,
    activeDays: 0,
  };
}

function addUsageTotals(target: UsageWindowTotals, source: UsageTotals): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.totalTokens += source.totalTokens;

  if (source.costUsd !== undefined) {
    target.costUsd = addUsd(target.costUsd ?? 0, source.costUsd);
  }

  if (source.costIncomplete) {
    target.costIncomplete = true;
  }
}

function activeDaysBySource(
  events: UsageEvent[],
  timezone: string,
): {
  totalDays: Set<string>;
  sourceDays: Map<string, Set<string>>;
} {
  const totalDays = new Set<string>();
  const sourceDays = new Map<string, Set<string>>();

  for (const event of events) {
    const day = getPeriodKey(event.timestamp, 'daily', timezone);
    totalDays.add(day);

    const days = sourceDays.get(event.source) ?? new Set<string>();
    days.add(day);
    sourceDays.set(event.source, days);
  }

  return { totalDays, sourceDays };
}

function eventCountsBySource(events: UsageEvent[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const event of events) {
    counts.set(event.source, (counts.get(event.source) ?? 0) + 1);
  }

  return counts;
}

function findGrandTotal(rows: UsageReportRow[]): UsageTotals {
  const grandTotal = rows.find((row) => row.rowType === 'grand_total');

  if (!grandTotal) {
    return createEmptyWindowTotals();
  }

  return grandTotal;
}

/** Totals of one date window, overall and per source. Callers pass in-window events. */
export function summarizeUsageWindow(
  events: UsageEvent[],
  timezone: string,
  sourceOrder: string[],
): UsageWindowSummary {
  const rows = aggregateUsage(events, {
    granularity: 'daily',
    timezone,
    sourceOrder,
    includeModelBreakdown: false,
  });
  const sourceCounts = eventCountsBySource(events);
  const activeDays = activeDaysBySource(events, timezone);
  const totals = createEmptyWindowTotals();
  addUsageTotals(totals, findGrandTotal(rows));
  totals.events = events.length;
  totals.activeDays = activeDays.totalDays.size;

  const sources = new Map<string, UsageWindowTotals>();

  for (const row of rows) {
    if (row.rowType !== 'period_source') {
      continue;
    }

    const sourceTotals = sources.get(row.source) ?? createEmptyWindowTotals();
    addUsageTotals(sourceTotals, row);
    sources.set(row.source, sourceTotals);
  }

  for (const [source, sourceTotals] of sources) {
    sourceTotals.events = sourceCounts.get(source) ?? 0;
    sourceTotals.activeDays = activeDays.sourceDays.get(source)?.size ?? 0;
  }

  return { totals, sources };
}
