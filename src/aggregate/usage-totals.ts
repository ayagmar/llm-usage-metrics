import type { UsageEvent } from '../domain/usage-event.js';
import type { TokenBuckets, UsageTotals } from '../domain/usage-report-row.js';
import { addUsd } from '../utils/usd-math.js';

type CostTotals = Pick<UsageTotals, 'costUsd' | 'costIncomplete'>;

/** For reports that keep only the token total and the cost of each bucket. */
export type TokenCostTotals = CostTotals & Pick<UsageTotals, 'totalTokens'>;

/**
 * What a `costUsd` and `costIncomplete` pair says: `none` when nothing was priced or missed,
 * `known` when every event has a cost, `partial` when only some do, `unknown` when none do.
 */
export type CostState = 'none' | 'known' | 'partial' | 'unknown';

export function getCostState(totals: CostTotals): CostState {
  if (totals.costUsd === undefined) {
    return totals.costIncomplete ? 'unknown' : 'none';
  }

  return totals.costIncomplete ? 'partial' : 'known';
}

export function createEmptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

export function addTokenBuckets(target: TokenBuckets, source: TokenBuckets): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.totalTokens += source.totalTokens;
}

export function mergeCostIncomplete(target: CostTotals, source: CostTotals): void {
  if (source.costIncomplete) {
    target.costIncomplete = true;
  }
}

/** The `costIncomplete` of a value derived from both sides. */
export function eitherCostIncomplete(left: CostTotals, right: CostTotals): true | undefined {
  return left.costIncomplete || right.costIncomplete ? true : undefined;
}

function addEventCost(target: CostTotals, event: UsageEvent): void {
  if (event.costUsd === undefined) {
    target.costIncomplete = true;
    return;
  }

  target.costUsd = addUsd(target.costUsd ?? 0, event.costUsd);
}

function addCost(target: CostTotals, source: CostTotals): void {
  if (source.costUsd !== undefined) {
    target.costUsd = addUsd(target.costUsd ?? 0, source.costUsd);
  }

  mergeCostIncomplete(target, source);
}

export function addEventToTotals(target: UsageTotals, event: UsageEvent): void {
  addTokenBuckets(target, event);
  addEventCost(target, event);
}

export function addTotals(target: UsageTotals, source: UsageTotals): void {
  addTokenBuckets(target, source);
  addCost(target, source);
}

export function addEventToTokenCostTotals(target: TokenCostTotals, event: UsageEvent): void {
  target.totalTokens += event.totalTokens;
  addEventCost(target, event);
}

export function addTokenCostTotals(target: TokenCostTotals, source: TokenCostTotals): void {
  target.totalTokens += source.totalTokens;
  addCost(target, source);
}
