export type EfficiencyUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
  costIncomplete?: boolean;
};

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

export type EfficiencyGrandTotalRow = EfficiencyUsageTotals &
  EfficiencyOutcomeTotals &
  EfficiencyDerivedMetrics & {
    rowType: 'grand_total';
    periodKey: 'ALL';
  };

export type EfficiencyRow = EfficiencyPeriodRow | EfficiencyGrandTotalRow;

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
