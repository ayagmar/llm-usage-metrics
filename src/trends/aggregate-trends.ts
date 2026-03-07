import type {
  PeriodCombinedRow,
  PeriodSourceRow,
  UsageReportRow,
} from '../domain/usage-report-row.js';
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

const VALUE_PRECISION_SCALE = 1_000_000_000_000;

function addValue(left: number, right: number): number {
  return Math.round((left + right) * VALUE_PRECISION_SCALE) / VALUE_PRECISION_SCALE;
}

function divideValue(value: number, divisor: number): number {
  return Math.round((value / divisor) * VALUE_PRECISION_SCALE) / VALUE_PRECISION_SCALE;
}

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

function createEmptyUsageRow(
  periodKey: string,
  rowType: 'period_source',
  source: string,
): PeriodSourceRow;
function createEmptyUsageRow(
  periodKey: string,
  rowType: 'period_combined',
  source: 'combined',
): PeriodCombinedRow;
function createEmptyUsageRow(
  periodKey: string,
  rowType: 'period_source' | 'period_combined',
  source: string,
): PeriodSourceRow | PeriodCombinedRow {
  return rowType === 'period_combined'
    ? {
        rowType,
        periodKey,
        source: 'combined',
        models: [],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      }
    : {
        rowType,
        periodKey,
        source,
        models: [],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      };
}

function addRowTotals(target: UsageReportRow, row: UsageReportRow): UsageReportRow {
  return {
    ...target,
    inputTokens: target.inputTokens + row.inputTokens,
    outputTokens: target.outputTokens + row.outputTokens,
    reasoningTokens: target.reasoningTokens + row.reasoningTokens,
    cacheReadTokens: target.cacheReadTokens + row.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + row.cacheWriteTokens,
    totalTokens: target.totalTokens + row.totalTokens,
    costUsd:
      row.costUsd !== undefined ? addValue(target.costUsd ?? 0, row.costUsd) : target.costUsd,
    costIncomplete:
      target.costIncomplete === true || row.costIncomplete === true ? true : undefined,
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

    const existingSourceOnlyRow =
      sourceOnlyByDate.get(row.periodKey) ??
      createEmptyUsageRow(row.periodKey, 'period_combined', 'combined');
    sourceOnlyByDate.set(row.periodKey, addRowTotals(existingSourceOnlyRow, row));
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
    const existingSourceRow =
      sourceRows.get(row.periodKey) ??
      createEmptyUsageRow(row.periodKey, 'period_source', row.source);
    sourceRows.set(row.periodKey, addRowTotals(existingSourceRow, row));
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
