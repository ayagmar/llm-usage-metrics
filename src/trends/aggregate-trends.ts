import type { UsageReportRow } from '../domain/usage-report-row.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getLocalDateKeyRange } from '../utils/time-buckets.js';
import type { TrendBucket, TrendSeries, TrendsMetric } from './trends-series.js';

type AggregateTrendsOptions = {
  dateRange: {
    from: string;
    to: string;
  };
  metric: TrendsMetric;
  bySource: boolean;
  sourceOrder: readonly string[];
};

type AggregateTrendsResult = {
  totalSeries: TrendSeries;
  sourceSeries?: TrendSeries[];
};

function toTrendBucket(row: UsageReportRow, metric: TrendsMetric): TrendBucket {
  return {
    date: row.periodKey,
    value: metric === 'tokens' ? row.totalTokens : (row.costUsd ?? 0),
    observed: true,
    incomplete: metric === 'cost' ? row.costIncomplete : undefined,
  };
}

function createGapBucket(date: string): TrendBucket {
  return {
    date,
    value: 0,
    observed: false,
  };
}

function buildTrendSummary(buckets: TrendBucket[]) {
  if (buckets.length === 0) {
    return {
      total: 0,
      average: 0,
      peak: {
        date: '',
        value: 0,
      },
      incomplete: false,
      observedDayCount: 0,
    };
  }

  const total = buckets.reduce((sum, bucket) => sum + bucket.value, 0);
  const observedBuckets = buckets.filter((bucket) => bucket.observed);

  if (observedBuckets.length === 0) {
    return {
      total,
      average: buckets.length > 0 ? total / buckets.length : 0,
      peak: {
        date: '',
        value: 0,
      },
      incomplete: buckets.some((bucket) => bucket.incomplete === true),
      observedDayCount: 0,
    };
  }

  const [firstBucket, ...remainingBuckets] = observedBuckets;
  const peak = remainingBuckets.reduce(
    (best, bucket) => (bucket.value > best.value ? bucket : best),
    firstBucket,
  );

  return {
    total,
    average: buckets.length > 0 ? total / buckets.length : 0,
    peak: {
      date: peak.date,
      value: peak.value,
    },
    incomplete: buckets.some((bucket) => bucket.incomplete === true),
    observedDayCount: observedBuckets.length,
  };
}

function buildSeries(
  source: TrendSeries['source'],
  rowsByDate: ReadonlyMap<string, UsageReportRow>,
  dateKeys: readonly string[],
  metric: TrendsMetric,
): TrendSeries {
  const buckets = dateKeys.map((date) => {
    const row = rowsByDate.get(date);
    return row ? toTrendBucket(row, metric) : createGapBucket(date);
  });

  return {
    source,
    buckets,
    summary: buildTrendSummary(buckets),
  };
}

function toCombinedRowsByDate(rows: UsageReportRow[]): Map<string, UsageReportRow> {
  const combinedByDate = new Map<string, UsageReportRow>();
  const sourceOnlyByDate = new Map<string, UsageReportRow>();

  for (const row of rows) {
    if (row.rowType === 'grand_total') {
      continue;
    }

    if (row.rowType === 'period_combined') {
      combinedByDate.set(row.periodKey, row);
      continue;
    }

    if (!sourceOnlyByDate.has(row.periodKey)) {
      sourceOnlyByDate.set(row.periodKey, row);
    }
  }

  const resolved = new Map<string, UsageReportRow>();

  for (const [date, row] of sourceOnlyByDate) {
    resolved.set(date, row);
  }

  for (const [date, row] of combinedByDate) {
    resolved.set(date, row);
  }

  return resolved;
}

function toSourceSeries(
  rows: UsageReportRow[],
  dateKeys: readonly string[],
  options: AggregateTrendsOptions,
): TrendSeries[] | undefined {
  if (!options.bySource) {
    return undefined;
  }

  const rowsBySource = new Map<string, Map<string, UsageReportRow>>();

  for (const row of rows) {
    if (row.rowType !== 'period_source') {
      continue;
    }

    const sourceRows = rowsBySource.get(row.source) ?? new Map<string, UsageReportRow>();
    sourceRows.set(row.periodKey, row);
    rowsBySource.set(row.source, sourceRows);
  }

  const observedSources = [...rowsBySource.keys()].sort((left, right) => {
    const leftIndex = options.sourceOrder.indexOf(left);
    const rightIndex = options.sourceOrder.indexOf(right);

    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) {
        return 1;
      }

      if (rightIndex === -1) {
        return -1;
      }

      return leftIndex - rightIndex;
    }

    return compareByCodePoint(left, right);
  });

  return observedSources.map((source) =>
    buildSeries(
      source,
      rowsBySource.get(source) ?? new Map<string, UsageReportRow>(),
      dateKeys,
      options.metric,
    ),
  );
}

export function aggregateTrends(
  rows: UsageReportRow[],
  options: AggregateTrendsOptions,
): AggregateTrendsResult {
  const dateKeys = getLocalDateKeyRange(options.dateRange.from, options.dateRange.to);

  return {
    totalSeries: buildSeries('combined', toCombinedRowsByDate(rows), dateKeys, options.metric),
    sourceSeries: toSourceSeries(rows, dateKeys, options),
  };
}
