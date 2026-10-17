import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import { buildEventProjectLabels, toProjectKey } from '../aggregate/project-key.js';
import { findSpendSpikes, resolveSpikeBaselineStart } from '../aggregate/spend-spikes.js';
import { computeActiveMs } from '../domain/active-time.js';
import { getEventSessionKey, type UsageEvent } from '../domain/usage-event.js';
import type { ProjectUsageReportRow, UsageReportRow } from '../domain/usage-report-row.js';
import { aggregateProjectTrends, aggregateTrends } from '../trends/aggregate-trends.js';
import { createPricingRunStats, DEFAULT_PRICING_POLICY } from '../pricing/cost-engine.js';
import { getCurrentLocalDateKey, getPeriodKey, shiftLocalDateKey } from '../utils/time-buckets.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { validateDateInput, validateTimezone } from './build-usage-data-inputs.js';
import { parseLastOption } from './build-usage-data.js';
import {
  applyPricingToUsageEventDataset,
  withPricingNotes,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import type {
  BuildTrendsDataDeps,
  TrendsCommandOptions,
  TrendsDataResult,
} from './usage-data-contracts.js';
import type {
  ProjectTrendSeries,
  ProjectTrendValueRow,
  TrendSeries,
  TrendsMetric,
  TrendValueRow,
} from '../trends/trends-series.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';

/** Trends data, with one series per project under `--by-repo`. */
export type TrendsReportData = TrendsDataResult & {
  projectSeries?: ProjectTrendSeries[];
};

type ResolvedDateRange = {
  from: string;
  to: string;
};

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
  if (options.byRepo && options.bySource) {
    throw new Error('--by-repo cannot be combined with --by-source; pass one of them');
  }

  if (options.last !== undefined && options.days !== undefined) {
    throw new Error('--days is an alias of --last; pass only --last');
  }

  const daysFlag = options.days === undefined ? '--last' : '--days';
  const daysValue = options.last ?? options.days;

  if (daysValue !== undefined && (options.since || options.until)) {
    throw new Error(`${daysFlag} cannot be combined with --since or --until`);
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
  const days = parseLastOption(daysValue, daysFlag);
  const today = getCurrentLocalDateKey(timezone, now);

  return {
    days,
    metric,
    fetchDateRange: resolveFetchDateRange(options, today, days),
    today,
  };
}

function filterRowsToDateRange<Row extends { periodKey: string }>(
  rows: Row[],
  dateRange: ResolvedDateRange,
): Row[] {
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

function toProjectTrendValueRows(
  rows: ProjectUsageReportRow[],
  metric: 'cost' | 'tokens',
): ProjectTrendValueRow[] {
  return rows.flatMap((row) =>
    row.rowType === 'period_project'
      ? [
          {
            periodKey: row.periodKey,
            repoRoot: row.repoRoot,
            project: row.project,
            value: metric === 'tokens' ? row.totalTokens : (row.costUsd ?? 0),
            incomplete: metric === 'cost' ? row.costIncomplete : undefined,
          },
        ]
      : [],
  );
}

// Per-day gap-capped active time: order a day's events by session, split each session
// into runs of consecutive events in one group, run computeActiveMs per run, and sum per
// source (or per project). A session crossing midnight splits at the day boundary; with
// --by-repo, a session splits at each project switch, so a return to a project is a new
// run and the projects never sum to more than the combined time.
function sumActiveMsByDay<Group>(
  events: readonly UsageEvent[],
  timezone: string,
  groupOf: (event: UsageEvent) => Group,
): { periodKey: string; group: Group; value: number }[] {
  const sessionsByDate = new Map<string, Map<string, { timestampMs: number; group: Group }[]>>();

  for (const event of events) {
    const timestampMs = Date.parse(event.timestamp);

    if (Number.isNaN(timestampMs)) {
      continue;
    }

    const dateKey = getPeriodKey(event.timestamp, 'daily', timezone);
    const sessions =
      sessionsByDate.get(dateKey) ?? new Map<string, { timestampMs: number; group: Group }[]>();
    const sessionKey = getEventSessionKey(event);
    const sessionEvents = sessions.get(sessionKey) ?? [];
    sessionEvents.push({ timestampMs, group: groupOf(event) });
    sessions.set(sessionKey, sessionEvents);
    sessionsByDate.set(dateKey, sessions);
  }

  const rows: { periodKey: string; group: Group; value: number }[] = [];

  for (const [periodKey, sessions] of sessionsByDate) {
    const activeMsByGroup = new Map<Group, number>();

    for (const sessionEvents of sessions.values()) {
      sessionEvents.sort((left, right) => left.timestampMs - right.timestampMs);
      let runStart = 0;

      for (let index = 1; index <= sessionEvents.length; index += 1) {
        const group = sessionEvents[runStart].group;

        if (index < sessionEvents.length && sessionEvents[index].group === group) {
          continue;
        }

        const runMs = computeActiveMs(
          sessionEvents.slice(runStart, index).map((entry) => entry.timestampMs),
        );
        activeMsByGroup.set(group, (activeMsByGroup.get(group) ?? 0) + runMs);
        runStart = index;
      }
    }

    for (const [group, value] of activeMsByGroup) {
      rows.push({ periodKey, group, value });
    }
  }

  return rows;
}

function toActiveTimeValueRows(events: readonly UsageEvent[], timezone: string): TrendValueRow[] {
  return sumActiveMsByDay(events, timezone, (event) => event.source).map((row) => ({
    periodKey: row.periodKey,
    source: row.group,
    value: row.value,
  }));
}

function toActiveTimeProjectValueRows(
  events: readonly UsageEvent[],
  timezone: string,
  projectLabels: ReadonlyMap<string | undefined, string>,
): ProjectTrendValueRow[] {
  return sumActiveMsByDay(events, timezone, (event) => toProjectKey(event.repoRoot)).map((row) => {
    const project = projectLabels.get(row.group);

    if (project === undefined) {
      throw new Error(`No project label for ${row.group ?? 'unattributed usage'}`);
    }

    return { periodKey: row.periodKey, repoRoot: row.group ?? null, project, value: row.value };
  });
}

/**
 * Sets `spike` on the series' spike days. `dailyValueRows` are cost rows reaching back
 * `SPIKE_BASELINE_DAYS` before the series, which the spike check compares each day against.
 */
function markSpendSpikes(
  series: TrendSeries,
  dailyValueRows: TrendValueRow[],
  dateRange: ResolvedDateRange,
  sourceOrder: readonly string[],
): void {
  const baselineRange = { from: resolveSpikeBaselineStart(dateRange.from), to: dateRange.to };
  const { totalSeries } = aggregateTrends(filterRowsToDateRange(dailyValueRows, baselineRange), {
    dateRange: baselineRange,
    bySource: false,
    sourceOrder,
  });
  const spikeDates = new Set(
    findSpendSpikes(
      new Map(totalSeries.buckets.map((bucket) => [bucket.date, bucket.value])),
      dateRange,
    ).map((spike) => spike.date),
  );

  for (const bucket of series.buckets) {
    if (spikeDates.has(bucket.date)) {
      bucket.spike = true;
    }
  }
}

export async function buildTrendsData(
  options: TrendsCommandOptions,
  deps: BuildTrendsDataDeps = {},
): Promise<TrendsReportData> {
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options as TrendsCommandOptions;
  const now = deps.now?.() ?? new Date();
  const timezone =
    configuredOptions.timezone?.trim() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  validateTimezone(timezone);
  const resolved = resolveTrendsOptions(configuredOptions, timezone, now);
  // Spike days need the cost of the days before the chart.
  const fetchFrom =
    resolved.fetchDateRange && resolved.metric === 'cost'
      ? resolveSpikeBaselineStart(resolved.fetchDateRange.from)
      : resolved.fetchDateRange?.from;
  const datasetOptions = {
    ...configuredOptions,
    timezone,
    since: fetchFrom ?? configuredOptions.since,
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
          pricingPolicy: DEFAULT_PRICING_POLICY,
          pricingStats: createPricingRunStats(),
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
  const sourceOrder = dataset.adaptersToParse.map((adapter) => adapter.id);
  const trends = measureRuntimeProfileStageSync(deps.runtimeProfile, 'trends.aggregate', () => {
    const aggregated = aggregateTrends(filterRowsToDateRange(dailyValueRows, outputDateRange), {
      dateRange: outputDateRange,
      bySource: options.bySource === true,
      sourceOrder,
    });

    if (resolved.metric === 'cost') {
      markSpendSpikes(aggregated.totalSeries, dailyValueRows, outputDateRange, sourceOrder);
    }

    return aggregated;
  });
  // A cost dataset reaches back past the chart for the spike check; the rest of the report
  // reads the chart's days only.
  const chartedEvents =
    resolved.metric === 'cost'
      ? pricingResult.pricedEvents.filter((event) => {
          const day = getPeriodKey(event.timestamp, 'daily', dataset.normalizedInputs.timezone);
          return day >= outputDateRange.from && day <= outputDateRange.to;
        })
      : dataset.filteredEvents;
  const projectSeries = options.byRepo
    ? measureRuntimeProfileStageSync(deps.runtimeProfile, 'trends.aggregate_projects', () => {
        // One label set over the whole range, so a project keeps its label on every day.
        const projectLabels = buildEventProjectLabels(chartedEvents);
        const projectRows =
          resolved.metric === 'active-hours'
            ? toActiveTimeProjectValueRows(
                chartedEvents,
                dataset.normalizedInputs.timezone,
                projectLabels,
              )
            : toProjectTrendValueRows(
                aggregateUsage(chartedEvents, {
                  granularity: 'daily',
                  timezone: dataset.normalizedInputs.timezone,
                  includeModelBreakdown: false,
                  primary: 'repo',
                  projectLabels,
                }),
                resolved.metric,
              );

        return aggregateProjectTrends(
          filterRowsToDateRange(projectRows, outputDateRange),
          outputDateRange,
        );
      })
    : undefined;
  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin: pricingResult.pricingOrigin,
    pricingWarning: pricingResult.pricingWarning,
    warnings: dataset.warnings,
    // Only cost trends show `~`, and only for the days in the chart.
    notes: withPricingNotes(
      dataset.notes,
      resolved.metric === 'cost' ? chartedEvents : [],
      pricingResult,
    ),
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
    projectSeries,
    diagnostics,
  };
}
