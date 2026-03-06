import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import type { UsageReportRow } from '../domain/usage-report-row.js';
import { aggregateTrends } from '../trends/aggregate-trends.js';
import { getCurrentLocalDateKey, shiftLocalDateKey } from '../utils/time-buckets.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { validateDateInput, validateTimezone } from './build-usage-data-inputs.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import type {
  BuildTrendsDataDeps,
  TrendsCommandOptions,
  TrendsDataResult,
} from './usage-data-contracts.js';
import type { TrendsMetric } from '../trends/trends-series.js';

type ResolvedDateRange = {
  from: string;
  to: string;
};

function parseDaysOption(days: string | undefined): number | undefined {
  if (days === undefined) {
    return undefined;
  }

  const trimmedDays = days.trim();

  if (!/^[1-9]\d*$/u.test(trimmedDays)) {
    throw new Error('--days must be a positive integer');
  }

  return Number.parseInt(trimmedDays, 10);
}

function resolveMetric(metric: string | undefined): TrendsMetric {
  if (metric === undefined || metric.trim() === '') {
    return 'cost';
  }

  const normalizedMetric = metric.trim().toLowerCase();

  if (normalizedMetric === 'cost' || normalizedMetric === 'tokens') {
    return normalizedMetric;
  }

  throw new Error('--metric must be one of: cost, tokens');
}

function resolveTrailingDateRange(today: string, days: number): ResolvedDateRange {
  return {
    from: shiftLocalDateKey(today, -(days - 1)),
    to: today,
  };
}

function resolveFetchDateRange(
  options: TrendsCommandOptions,
  today: string,
  days: number | undefined,
): ResolvedDateRange | undefined {
  if (days !== undefined) {
    return resolveTrailingDateRange(today, days);
  }

  if (!options.since && !options.until) {
    return resolveTrailingDateRange(today, 30);
  }

  if (options.since && options.until) {
    return {
      from: options.since,
      to: options.until,
    };
  }

  if (options.since) {
    return {
      from: options.since,
      to: options.since > today ? options.since : today,
    };
  }

  return undefined;
}

function resolveOutputDateRange(
  options: TrendsCommandOptions,
  today: string,
  days: number | undefined,
  observedDates: readonly string[],
): ResolvedDateRange {
  if (days !== undefined) {
    return resolveTrailingDateRange(today, days);
  }

  if (!options.since && !options.until) {
    return resolveTrailingDateRange(today, 30);
  }

  if (options.since && options.until) {
    return {
      from: options.since,
      to: options.until,
    };
  }

  if (options.since) {
    return {
      from: options.since,
      to: options.since > today ? options.since : today,
    };
  }

  const earliestObservedDate = observedDates.at(0);

  if (!options.until) {
    throw new Error('--until is required when resolving an until-only trends range');
  }

  return {
    from: earliestObservedDate ?? options.until,
    to: options.until,
  };
}

function resolveTrendsOptions(
  options: TrendsCommandOptions,
  timezone: string,
  now: Date,
): {
  days: number | undefined;
  metric: TrendsMetric;
  fetchDateRange: ResolvedDateRange | undefined;
  today: string;
} {
  if (options.days !== undefined && (options.since || options.until)) {
    throw new Error('--days cannot be combined with --since or --until');
  }

  if (options.since) {
    validateDateInput(options.since, '--since');
  }

  if (options.until) {
    validateDateInput(options.until, '--until');
  }

  if (options.since && options.until && options.since > options.until) {
    throw new Error('--since must be less than or equal to --until');
  }

  const metric = resolveMetric(options.metric);
  const days = parseDaysOption(options.days);
  const today = getCurrentLocalDateKey(timezone, now);

  return {
    days,
    metric,
    fetchDateRange: resolveFetchDateRange(options, today, days),
    today,
  };
}

function filterRowsToDateRange(rows: UsageReportRow[], dateRange: ResolvedDateRange) {
  return rows.filter(
    (row) =>
      row.periodKey !== 'ALL' && row.periodKey >= dateRange.from && row.periodKey <= dateRange.to,
  );
}

export async function buildTrendsData(
  options: TrendsCommandOptions,
  deps: BuildTrendsDataDeps = {},
): Promise<TrendsDataResult> {
  const now = deps.now?.() ?? new Date();
  const timezone = options.timezone?.trim() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  validateTimezone(timezone);
  const resolved = resolveTrendsOptions(options, timezone, now);
  const dataset = await buildUsageEventDataset(
    {
      ...options,
      timezone,
      since: resolved.fetchDateRange?.from ?? options.since,
      until: resolved.fetchDateRange?.to ?? options.until,
    },
    deps,
  );
  const pricingResult =
    resolved.metric === 'cost'
      ? await applyPricingToUsageEventDataset(dataset, deps, 'auto')
      : {
          pricedEvents: dataset.filteredEvents,
          pricingOrigin: 'none' as const,
          pricingWarning: undefined,
        };
  const dailyRows = aggregateUsage(pricingResult.pricedEvents, {
    granularity: 'daily',
    timezone: dataset.normalizedInputs.timezone,
    sourceOrder: dataset.adaptersToParse.map((adapter) => adapter.id),
    includeModelBreakdown: false,
  });
  const observedDates = dailyRows
    .filter((row) => row.rowType !== 'grand_total')
    .map((row) => row.periodKey)
    .sort();
  const outputDateRange = resolveOutputDateRange(options, resolved.today, resolved.days, [
    ...new Set(observedDates),
  ]);
  const trends = aggregateTrends(filterRowsToDateRange(dailyRows, outputDateRange), {
    dateRange: outputDateRange,
    metric: resolved.metric,
    bySource: options.bySource === true,
    sourceOrder: dataset.adaptersToParse.map((adapter) => adapter.id),
  });
  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin: pricingResult.pricingOrigin,
    pricingWarning: pricingResult.pricingWarning,
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    timezone: dataset.normalizedInputs.timezone,
  });

  return {
    metric: resolved.metric,
    dateRange: outputDateRange,
    totalSeries: trends.totalSeries,
    sourceSeries: options.bySource ? (trends.sourceSeries ?? []) : undefined,
    diagnostics,
  };
}
