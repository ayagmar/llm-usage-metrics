import type { SourceId } from './usage-event.js';

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
  models: string[];
  modelBreakdown: ModelUsageBreakdown[];
};

export type PeriodCombinedRow = UsageTotals & {
  rowType: 'period_combined';
  periodKey: string;
  source: 'combined';
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
