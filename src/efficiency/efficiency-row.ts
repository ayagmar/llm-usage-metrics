import type { UsageTotals } from '../domain/usage-report-row.js';

export type EfficiencyUsageTotals = UsageTotals;

export type EfficiencyOutcomeTotals = {
  commitCount: number;
  linesAdded: number;
  linesDeleted: number;
  linesChanged: number;
};

export type EfficiencyDerivedMetrics = {
  usdPerCommit?: number;
  usdPer1kLinesChanged?: number;
  tokensPerCommit?: number;
  commitsPerUsd?: number;
};

export type EfficiencyPeriodRow = EfficiencyUsageTotals &
  EfficiencyOutcomeTotals &
  EfficiencyDerivedMetrics & {
    rowType: 'period';
    periodKey: string;
  };

export type EfficiencySourceRow = EfficiencyUsageTotals & {
  rowType: 'period_source';
  periodKey: string;
  source: string;
  costShare?: number;
};

export type EfficiencyGrandTotalRow = EfficiencyUsageTotals &
  EfficiencyOutcomeTotals &
  EfficiencyDerivedMetrics & {
    rowType: 'grand_total';
    periodKey: 'ALL';
  };

export type EfficiencyRow = EfficiencyPeriodRow | EfficiencySourceRow | EfficiencyGrandTotalRow;

export function createEmptyEfficiencyUsageTotals(): EfficiencyUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

export function createEmptyEfficiencyOutcomeTotals(): EfficiencyOutcomeTotals {
  return {
    commitCount: 0,
    linesAdded: 0,
    linesDeleted: 0,
    linesChanged: 0,
  };
}
