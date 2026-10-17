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
  /** A spend spike (see `findSpendSpikes`); set on the combined cost series only. */
  spike?: true;
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

/** One project's metric value on one day (`--by-repo`). */
export type ProjectTrendValueRow = {
  periodKey: string;
  /** The project key, `null` for usage without a repository root. */
  repoRoot: string | null;
  project: string;
  value: number;
  incomplete?: boolean;
};

/** One project's daily series (`--by-repo`). */
export type ProjectTrendSeries = {
  /** The project key, `null` for usage without a repository root. */
  repoRoot: string | null;
  project: string;
  buckets: TrendBucket[];
  summary: TrendSummary;
};
