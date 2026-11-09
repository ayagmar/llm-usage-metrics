import type { ShareCostMode, ShareCosts } from '../../types.js';
import { COST_MODES, type ShareReport } from './decode.js';
import { formatUsd } from '../../../render/format-number.js';
import { HOUR_MS } from '../../../utils/time-constants.js';

/** Shown where a ratio has no denominator, such as cost per hour with no time. */
export const NO_VALUE = '—';

/**
 * One mode's cost for display: `none` when the file holds no cost (--no-cost), `unavailable`
 * when pricing failed for that mode, otherwise the sum (null when no event had a cost) and
 * how many events had none.
 */
export type ShareCostValue =
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'value'; costUsd: number | null; incompleteEvents: number };

/** The modes the file holds a cost for, in a fixed order. */
export function getAvailableCostModes(report: ShareReport): ShareCostMode[] {
  return COST_MODES.filter((mode) => report.data.cube.costs[mode] !== undefined);
}

/** The mode the page opens on: the command's own when the file holds it, else the first held. */
export function getDefaultCostMode(report: ShareReport): ShareCostMode | null {
  const available = getAvailableCostModes(report);
  const commandMode = report.data.meta.costMode;

  return commandMode !== null && available.includes(commandMode)
    ? commandMode
    : (available[0] ?? null);
}

export function getCost(
  report: ShareReport,
  costs: ShareCosts,
  mode: ShareCostMode | null,
): ShareCostValue {
  if (mode === null) {
    return { kind: 'none' };
  }

  const cost = costs[mode];

  if (!cost || report.data.meta.unavailableCostModes.includes(mode)) {
    return { kind: 'unavailable' };
  }

  return { kind: 'value', costUsd: cost.costUsd, incompleteEvents: cost.incompleteEvents };
}

/** The cost as a number for sorting and charts: 0 when absent, null when there is none to show. */
export function getCostAmount(value: ShareCostValue): number | null {
  return value.kind === 'value' ? (value.costUsd ?? 0) : null;
}

/**
 * Cache reads over every prompt token (input, cache reads, cache writes), the split the cost
 * engine prices; null with no prompt tokens.
 */
export function getCacheHitRate(totals: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number | null {
  const promptTokens = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  return promptTokens > 0 ? totals.cacheReadTokens / promptTokens : null;
}

/** Cost per hour of `timeMs`; null without time or without a cost. */
export function getCostPerHour(costUsd: number | null, timeMs: number): number | null {
  return timeMs > 0 && costUsd !== null ? costUsd / (timeMs / HOUR_MS) : null;
}

/**
 * The time measure a view shows, worded once. Without label filters it is wall-clock Active
 * time; a filter leaves only the per-cell sum, Agent time, which a union cannot come from.
 */
export type ShareTimeMetric = {
  kind: 'active' | 'agent';
  label: 'Active time' | 'Agent time';
  costPerHourLabel: 'Cost per active hour' | 'Cost per agent hour';
  /** What the figure counts, in one line. */
  detail: string;
};

const ACTIVE_TIME_METRIC: ShareTimeMetric = {
  kind: 'active',
  label: 'Active time',
  costPerHourLabel: 'Cost per active hour',
  detail: 'Wall-clock; parallel sessions count once',
};

const AGENT_TIME_METRIC: ShareTimeMetric = {
  kind: 'agent',
  label: 'Agent time',
  costPerHourLabel: 'Cost per agent hour',
  detail: 'Summed across sessions; parallel sessions add up',
};

export function getTimeMetric(hasLabelFilters: boolean): ShareTimeMetric {
  return hasLabelFilters ? AGENT_TIME_METRIC : ACTIVE_TIME_METRIC;
}

/** `$1.23`, or {@link NO_VALUE} for a missing value. */
export function formatUsdOrNone(value: number | null): string {
  return value === null ? NO_VALUE : formatUsd(value);
}
