import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getLocalDateKeyRange } from '../utils/time-buckets.js';
import type { TrendBucket, TrendSeries, TrendValueRow } from './trends-series.js';

type AggregateTrendsOptions = {
  dateRange: {
    from: string;
    to: string;
  };
  bySource: boolean;
  sourceOrder: readonly string[];
};

type AggregateTrendsResult = {
  totalSeries: TrendSeries;
  sourceSeries?: TrendSeries[];
};

const VALUE_PRECISION_SCALE = 1_000_000_000_000;

function addValue(left: number, right: number): number {
  return Math.round((left + right) * VALUE_PRECISION_SCALE) / VALUE_PRECISION_SCALE;
}

function divideValue(value: number, divisor: number): number {
  return Math.round((value / divisor) * VALUE_PRECISION_SCALE) / VALUE_PRECISION_SCALE;
}

function toTrendBucket(row: TrendValueRow): TrendBucket {
  return {
    date: row.periodKey,
    value: row.value,
    observed: true,
    incomplete: row.incomplete,
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

  const total = buckets.reduce((sum, bucket) => addValue(sum, bucket.value), 0);
  const observedBuckets = buckets.filter((bucket) => bucket.observed);

  if (observedBuckets.length === 0) {
    return {
      total,
      average: buckets.length > 0 ? divideValue(total, buckets.length) : 0,
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
    average: buckets.length > 0 ? divideValue(total, buckets.length) : 0,
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
  rowsByDate: ReadonlyMap<string, TrendValueRow>,
  dateKeys: readonly string[],
): TrendSeries {
  const buckets = dateKeys.map((date) => {
    const row = rowsByDate.get(date);
    return row ? toTrendBucket(row) : createGapBucket(date);
  });

  return {
    source,
    buckets,
    summary: buildTrendSummary(buckets),
  };
}

function createEmptyValueRow(periodKey: string, source: TrendValueRow['source']): TrendValueRow {
  return {
    periodKey,
    source,
    value: 0,
  };
}

function addValueRows(target: TrendValueRow, row: TrendValueRow): TrendValueRow {
  return {
    ...target,
    value: addValue(target.value, row.value),
    incomplete: target.incomplete === true || row.incomplete === true ? true : undefined,
  };
}

function toCombinedRowsByDate(rows: TrendValueRow[]): Map<string, TrendValueRow> {
  const combinedByDate = new Map<string, TrendValueRow>();
  const sourceOnlyByDate = new Map<string, TrendValueRow>();

  for (const row of rows) {
    if (row.source === 'combined') {
      combinedByDate.set(row.periodKey, row);
      continue;
    }

    const existingSourceOnlyRow =
      sourceOnlyByDate.get(row.periodKey) ?? createEmptyValueRow(row.periodKey, 'combined');
    sourceOnlyByDate.set(row.periodKey, addValueRows(existingSourceOnlyRow, row));
  }

  const resolved = new Map<string, TrendValueRow>();

  for (const [date, row] of sourceOnlyByDate) {
    resolved.set(date, row);
  }

  for (const [date, row] of combinedByDate) {
    resolved.set(date, row);
  }

  return resolved;
}

function toSourceSeries(
  rows: TrendValueRow[],
  dateKeys: readonly string[],
  options: AggregateTrendsOptions,
): TrendSeries[] | undefined {
  if (!options.bySource) {
    return undefined;
  }

  const rowsBySource = new Map<string, Map<string, TrendValueRow>>();

  for (const row of rows) {
    if (row.source === 'combined') {
      continue;
    }

    const sourceRows = rowsBySource.get(row.source) ?? new Map<string, TrendValueRow>();
    const existingSourceRow =
      sourceRows.get(row.periodKey) ?? createEmptyValueRow(row.periodKey, row.source);
    sourceRows.set(row.periodKey, addValueRows(existingSourceRow, row));
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
    buildSeries(source, rowsBySource.get(source) ?? new Map<string, TrendValueRow>(), dateKeys),
  );
}

export function aggregateTrends(
  rows: TrendValueRow[],
  options: AggregateTrendsOptions,
): AggregateTrendsResult {
  const dateKeys = getLocalDateKeyRange(options.dateRange.from, options.dateRange.to);

  return {
    totalSeries: buildSeries('combined', toCombinedRowsByDate(rows), dateKeys),
    sourceSeries: toSourceSeries(rows, dateKeys, options),
  };
}
