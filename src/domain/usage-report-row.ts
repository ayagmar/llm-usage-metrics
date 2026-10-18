import type { SourceId } from '@ayagmar/agent-sessions';

export type TokenBuckets = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

export type UsageTotals = TokenBuckets & {
  costUsd?: number;
  costIncomplete?: boolean;
};

export type ModelUsageBreakdown = UsageTotals & {
  model: string;
};

export type PeriodSourceRow = UsageTotals & {
  rowType: 'period_source';
  periodKey: string;
  source: SourceId;
  /** With --by-machine: the machine the row's usage came from (`local` for this one). */
  machine?: string;
  /** With --by-repo: the project key, `null` for usage without a repository root. */
  repoRoot?: string | null;
  /** With --by-repo: the project's display label. */
  project?: string;
  /** Hourly only: the local hour occurred twice (a DST fall-back) and the row covers both. */
  repeatedHour?: true;
  models: string[];
  modelBreakdown: ModelUsageBreakdown[];
};

/** One project's usage in a period, across sources (projects, value and trends; never usage JSON). */
export type PeriodProjectRow = UsageTotals & {
  rowType: 'period_project';
  periodKey: string;
  /** The project key, `null` for usage without a repository root. */
  repoRoot: string | null;
  project: string;
  models: string[];
  modelBreakdown: ModelUsageBreakdown[];
};

export type PeriodCombinedRow = UsageTotals & {
  rowType: 'period_combined';
  periodKey: string;
  source: 'combined';
  /** Hourly only: the local hour occurred twice (a DST fall-back) and the row covers both. */
  repeatedHour?: true;
  models: string[];
  modelBreakdown: ModelUsageBreakdown[];
};

export type GrandTotalRow = UsageTotals & {
  rowType: 'grand_total';
  periodKey: 'ALL';
  source: 'combined';
  models: string[];
  modelBreakdown: ModelUsageBreakdown[];
};

export type UsageReportRow = PeriodSourceRow | PeriodCombinedRow | GrandTotalRow;

/** Rows of `aggregateUsage` with `primary: 'repo'`. */
export type ProjectUsageReportRow = PeriodProjectRow | PeriodCombinedRow | GrandTotalRow;
