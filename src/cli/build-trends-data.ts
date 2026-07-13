import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import { computeActiveMs } from '../domain/active-time.js';
import { getEventSessionKey, type UsageEvent } from '../domain/usage-event.js';
import type { UsageReportRow } from '../domain/usage-report-row.js';
import { aggregateTrends } from '../trends/aggregate-trends.js';
import { getCurrentLocalDateKey, getPeriodKey, shiftLocalDateKey } from '../utils/time-buckets.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
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
import type { TrendsMetric, TrendValueRow } from '../trends/trends-series.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';

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

  if (
    normalizedMetric === 'cost' ||
    normalizedMetric === 'tokens' ||
    normalizedMetric === 'active-hours'
  ) {
    return normalizedMetric;
  }

  throw new Error('--metric must be one of: cost, tokens, active-hours');
}

function resolveTrailingDateRange(today: string, days: number): ResolvedDateRange {
  return {
    from: shiftLocalDateKey(today, -(days - 1)),
    to: today,
  };
}

function assertUntilDefined(until: string | undefined): asserts until is string {
  if (until === undefined) {
    throw new Error('--until is required when resolving an until-only trends range');
  }
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
  const { until } = options;
  assertUntilDefined(until);

  return {
    from: earliestObservedDate ?? until,
    to: until,
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

function filterRowsToDateRange(rows: TrendValueRow[], dateRange: ResolvedDateRange) {
  return rows.filter(
    (row) =>
      row.periodKey !== 'ALL' && row.periodKey >= dateRange.from && row.periodKey <= dateRange.to,
  );
}

function toTrendValueRows(rows: UsageReportRow[], metric: 'cost' | 'tokens'): TrendValueRow[] {
  return rows.map((row) => ({
    periodKey: row.periodKey,
    source: row.source,
    value: metric === 'tokens' ? row.totalTokens : (row.costUsd ?? 0),
    incomplete: metric === 'cost' ? row.costIncomplete : undefined,
  }));
}

// Per-day gap-capped active time: group a day's events by session, run
// computeActiveMs per group, and sum per source. A session crossing midnight
// splits at the day boundary.
type ActiveTimeSessionGroup = {
  source: string;
  timestampsMs: number[];
};

function toActiveTimeValueRows(events: readonly UsageEvent[], timezone: string): TrendValueRow[] {
  const groupsByDate = new Map<string, Map<string, ActiveTimeSessionGroup>>();

  for (const event of events) {
    const timestampMs = Date.parse(event.timestamp);

    if (Number.isNaN(timestampMs)) {
      continue;
    }

    const dateKey = getPeriodKey(event.timestamp, 'daily', timezone);
    const sessions = groupsByDate.get(dateKey) ?? new Map<string, ActiveTimeSessionGroup>();
    const group = sessions.get(getEventSessionKey(event)) ?? {
      source: event.source,
      timestampsMs: [],
    };
    group.timestampsMs.push(timestampMs);
    sessions.set(getEventSessionKey(event), group);
    groupsByDate.set(dateKey, sessions);
  }

  const rows: TrendValueRow[] = [];

  for (const [dateKey, sessions] of groupsByDate) {
    const activeMsBySource = new Map<string, number>();

    for (const group of sessions.values()) {
      const activeMs = computeActiveMs(group.timestampsMs);
      activeMsBySource.set(group.source, (activeMsBySource.get(group.source) ?? 0) + activeMs);
    }

    for (const [source, activeMs] of activeMsBySource) {
      rows.push({ periodKey: dateKey, source, value: activeMs });
    }
  }

  return rows;
}

export async function buildTrendsData(
  options: TrendsCommandOptions,
  deps: BuildTrendsDataDeps = {},
): Promise<TrendsDataResult> {
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options as TrendsCommandOptions;
  const now = deps.now?.() ?? new Date();
  const timezone =
    configuredOptions.timezone?.trim() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  validateTimezone(timezone);
  const resolved = resolveTrendsOptions(configuredOptions, timezone, now);
  const datasetOptions = {
    ...configuredOptions,
    timezone,
    since: resolved.fetchDateRange?.from ?? configuredOptions.since,
    until: resolved.fetchDateRange?.to ?? configuredOptions.until,
  };
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'trends.dataset.total',
    () =>
      buildUsageEventDataset(datasetOptions, {
        ...deps,
        userConfigResolution: {
          ...userConfigResolution,
          options: datasetOptions,
        },
      }),
  );
  const pricingResult =
    resolved.metric === 'cost'
      ? await applyPricingToUsageEventDataset(dataset, deps, 'auto')
      : {
          pricedEvents: dataset.filteredEvents,
          pricingOrigin: 'none' as const,
          pricingWarning: undefined,
        };
  const dailyValueRows = measureRuntimeProfileStageSync(
    deps.runtimeProfile,
    'trends.aggregate_usage',
    () =>
      resolved.metric === 'active-hours'
        ? toActiveTimeValueRows(dataset.filteredEvents, dataset.normalizedInputs.timezone)
        : toTrendValueRows(
            aggregateUsage(pricingResult.pricedEvents, {
              granularity: 'daily',
              timezone: dataset.normalizedInputs.timezone,
              sourceOrder: dataset.adaptersToParse.map((adapter) => adapter.id),
              includeModelBreakdown: false,
            }),
            resolved.metric,
          ),
  );
  const observedDates = dailyValueRows
    .filter((row) => row.periodKey !== 'ALL')
    .map((row) => row.periodKey)
    .sort();
  const outputDateRange = resolveOutputDateRange(options, resolved.today, resolved.days, [
    ...new Set(observedDates),
  ]);
  const trends = measureRuntimeProfileStageSync(deps.runtimeProfile, 'trends.aggregate', () =>
    aggregateTrends(filterRowsToDateRange(dailyValueRows, outputDateRange), {
      dateRange: outputDateRange,
      bySource: options.bySource === true,
      sourceOrder: dataset.adaptersToParse.map((adapter) => adapter.id),
    }),
  );
  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin: pricingResult.pricingOrigin,
    pricingWarning: pricingResult.pricingWarning,
    warnings: dataset.warnings,
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  return {
    metric: resolved.metric,
    dateRange: outputDateRange,
    totalSeries: trends.totalSeries,
    sourceSeries: options.bySource ? (trends.sourceSeries ?? []) : undefined,
    diagnostics,
  };
}
