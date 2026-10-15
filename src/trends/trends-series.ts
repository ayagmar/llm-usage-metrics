import type { SourceId } from '../domain/usage-event.js';

export type TrendsMetric = 'cost' | 'tokens' | 'active-hours';

// One pre-extracted metric value per (day, source); 'combined' rows carry a
// source-spanning total that wins over summing the per-source rows.
export type TrendValueRow = {
  periodKey: string;
  /** A source id, or 'combined'. */
  source: SourceId;
  value: number;
  incomplete?: boolean;
};

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
  /** A source id, or 'combined'. */
  source: SourceId;
  buckets: TrendBucket[];
  summary: TrendSummary;
};
