import type { SourceId } from '../domain/usage-event.js';

export type TrendsMetric = 'cost' | 'tokens';

export type TrendBucket = {
  date: string;
  value: number;
  observed: boolean;
  incomplete?: boolean;
};

export type TrendSummary = {
  total: number;
  average: number;
  peak: { date: string; value: number };
  incomplete: boolean;
  observedDayCount: number;
};

export type TrendSeries = {
  source: 'combined' | SourceId;
  buckets: TrendBucket[];
  summary: TrendSummary;
};
