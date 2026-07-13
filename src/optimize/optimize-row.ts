import type { TokenBuckets } from '../domain/usage-report-row.js';

export type OptimizeRowType = 'baseline' | 'candidate';

export type OptimizeRowCommon = TokenBuckets & {
  rowType: OptimizeRowType;
  periodKey: string;
  provider: string;
};

export type OptimizeBaselineRow = OptimizeRowCommon & {
  rowType: 'baseline';
  baselineCostUsd: number | undefined;
  baselineCostIncomplete: boolean;
};

export type OptimizeCandidateRow = OptimizeRowCommon & {
  rowType: 'candidate';
  candidateModel: string;
  candidateResolvedModel: string;
  hypotheticalCostUsd: number | undefined;
  hypotheticalCostIncomplete: boolean;
  savingsUsd: number | undefined;
  savingsRatio: number | undefined;
  notes?: string[];
};

export type OptimizeRow = OptimizeBaselineRow | OptimizeCandidateRow;
