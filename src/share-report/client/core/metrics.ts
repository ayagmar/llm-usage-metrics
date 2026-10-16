import type { ShareCostMode, ShareCosts } from '../../types.js';
import { COST_MODES, type ShareReport } from './decode.js';

const HOUR_MS = 60 * 60 * 1000;

/** Shown where a ratio has no denominator, such as cost per active hour with no active time. */
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

/** Cost per active hour; null without active time or without a cost. */
export function getCostPerActiveHour(costUsd: number | null, activeMs: number): number | null {
  return activeMs > 0 && costUsd !== null ? costUsd / (activeMs / HOUR_MS) : null;
}

let usdFormatter: Intl.NumberFormat | undefined;

/** `$1.23`, or {@link NO_VALUE} for a missing value. */
export function formatUsdOrNone(value: number | null): string {
  if (value === null) {
    return NO_VALUE;
  }

  usdFormatter ??= new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return usdFormatter.format(value);
}
