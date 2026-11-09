import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import { buildEventProjectLabels, toProjectKey } from '../aggregate/project-key.js';
import { findSpendSpikes, resolveSpikeBaselineStart } from '../aggregate/spend-spikes.js';
import { getEventSessionKey } from '@ayagmar/agent-sessions';
import type { UsageEvent } from '../domain/usage-event.js';
import type { ProjectUsageReportRow, UsageReportRow } from '../domain/usage-report-row.js';
import { aggregateProjectTrends, aggregateTrends } from '../trends/aggregate-trends.js';
import {
  compareByCodePoint,
  computeActiveIntervals,
  createPricingRunStats,
  DEFAULT_PRICING_POLICY,
} from '@ayagmar/agent-sessions/internal';
import { forEachPeriodPart, getCurrentLocalDateKey, getPeriodKey } from '../utils/time-buckets.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import { buildDatasetDiagnostics } from './build-usage-data-diagnostics.js';
import { resolveReportTimezone, validateDateRangeOptions } from './build-usage-data-inputs.js';
import { parseLastOption, resolvePeriodsSince } from './build-usage-data.js';
import {
  applyPricingToUsageEventDataset,
  withPricingNotes,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import type {
  BuildTrendsDataDeps,
  ReportNote,
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
    from: resolvePeriodsSince('daily', today, days),
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

  if (options.all) {
    return undefined;
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

/**
 * The fetch range, or from the earliest observed date to --until alone, or to today with
 * --all.
 */
function resolveOutputDateRange(
  options: TrendsCommandOptions,
  today: string,
  days: number | undefined,
  observedDates: readonly string[],
): ResolvedDateRange {
  const fetchDateRange = resolveFetchDateRange(options, today, days);

  if (fetchDateRange) {
    return fetchDateRange;
  }

  const until = options.all ? today : options.until;
  assertUntilDefined(until);

  return {
    from: observedDates.at(0) ?? until,
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

  if (daysValue !== undefined && (options.since || options.until || options.all)) {
    throw new Error(`${daysFlag} cannot be combined with --since, --until, or --all`);
  }

  if (options.all && (options.since || options.until)) {
    throw new Error('--all cannot be combined with --since or --until');
  }

  validateDateRangeOptions(options);

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

// Per-day wall-clock active time: split each session into runs of consecutive events in one
// group and take the union of each group's runs, so parallel sessions count once. The
// `combined` value is the union of whole sessions across groups. Stretches split at local
// midnight, so a gap across it counts on both sides and a range sums to its union. With
// --by-repo, a session splits at each project switch: that gap counts for neither project,
// and a return to a project is a new run.
function sumActiveMsByDay<Group>(
  events: readonly UsageEvent[],
  timezone: string,
  groupOf: (event: UsageEvent) => Group,
): {
  rows: { periodKey: string; group: Group; value: number }[];
  combinedByDay: Map<string, number>;
} {
  const sessions = new Map<string, { timestampMs: number; group: Group }[]>();
  // Every day and group with an event has a row, even at zero: the chart marks it observed.
  const msByDayAndGroup = new Map<string, Map<Group, number>>();
  const combinedByDay = new Map<string, number>();

  for (const event of events) {
    const timestampMs = Date.parse(event.timestamp);

    if (Number.isNaN(timestampMs)) {
      continue;
    }

    const group = groupOf(event);
    const dateKey = getPeriodKey(event.timestamp, 'daily', timezone);
    const groups = msByDayAndGroup.get(dateKey) ?? new Map<Group, number>();
    groups.set(group, 0);
    msByDayAndGroup.set(dateKey, groups);
    combinedByDay.set(dateKey, 0);

    const sessionKey = getEventSessionKey(event);
    const sessionEvents = sessions.get(sessionKey) ?? [];
    sessionEvents.push({ timestampMs, group });
    sessions.set(sessionKey, sessionEvents);
  }

  const runsByGroup = new Map<Group, number[][]>();
  const sessionTimestamps: number[][] = [];

  for (const sessionEvents of sessions.values()) {
    sessionEvents.sort((left, right) => left.timestampMs - right.timestampMs);
    sessionTimestamps.push(sessionEvents.map((entry) => entry.timestampMs));
    let runStart = 0;

    for (let index = 1; index <= sessionEvents.length; index += 1) {
      const group = sessionEvents[runStart].group;

      if (index < sessionEvents.length && sessionEvents[index].group === group) {
        continue;
      }

      const runs = runsByGroup.get(group) ?? [];
      runs.push(sessionEvents.slice(runStart, index).map((entry) => entry.timestampMs));
      runsByGroup.set(group, runs);
      runStart = index;
    }
  }

  const dayKeyAt = (timestamp: string) => getPeriodKey(timestamp, 'daily', timezone);

  for (const [group, runs] of runsByGroup) {
    for (const [startMs, endMs] of computeActiveIntervals(runs)) {
      forEachPeriodPart(startMs, endMs, dayKeyAt, (dateKey, ms) => {
        const groups = msByDayAndGroup.get(dateKey);
        groups?.set(group, (groups.get(group) ?? 0) + ms);
      });
    }
  }

  for (const [startMs, endMs] of computeActiveIntervals(sessionTimestamps)) {
    forEachPeriodPart(startMs, endMs, dayKeyAt, (dateKey, ms) => {
      combinedByDay.set(dateKey, (combinedByDay.get(dateKey) ?? 0) + ms);
    });
  }

  const rows = [...msByDayAndGroup].flatMap(([periodKey, groups]) =>
    [...groups].map(([group, value]) => ({ periodKey, group, value })),
  );

  return { rows, combinedByDay };
}

/** One note per source whose sessions all have a single event, so its active time reads 0. */
function listSingleEventSourceNotes(events: readonly UsageEvent[]): ReportNote[] {
  const eventsBySession = new Map<string, { source: string; count: number }>();

  for (const event of events) {
    const key = getEventSessionKey(event);
    const session = eventsBySession.get(key) ?? { source: event.source, count: 0 };
    session.count += 1;
    eventsBySession.set(key, session);
  }

  const sources = new Map<string, boolean>();

  for (const { source, count } of eventsBySession.values()) {
    sources.set(source, (sources.get(source) ?? true) && count === 1);
  }

  return [...sources]
    .filter(([, singleEventOnly]) => singleEventOnly)
    .map(([source]) => source)
    .sort(compareByCodePoint)
    .map(
      (source) =>
        `${source} has only single-event sessions in this range, so its active time is 0: active time needs two events in a session.`,
    );
}

function toActiveTimeValueRows(events: readonly UsageEvent[], timezone: string): TrendValueRow[] {
  const { rows, combinedByDay } = sumActiveMsByDay(events, timezone, (event) => event.source);
  const sourceRows: TrendValueRow[] = rows.map((row) => ({
    periodKey: row.periodKey,
    source: row.group,
    value: row.value,
  }));
  const combinedRows: TrendValueRow[] = [...combinedByDay].map(([periodKey, value]) => ({
    periodKey,
    source: 'combined',
    value,
  }));

  return [...sourceRows, ...combinedRows];
}

function toActiveTimeProjectValueRows(
  events: readonly UsageEvent[],
  timezone: string,
  projectLabels: ReadonlyMap<string | undefined, string>,
): ProjectTrendValueRow[] {
  const { rows } = sumActiveMsByDay(events, timezone, (event) => toProjectKey(event.repoRoot));

  return rows.map((row) => {
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
  const timezone = resolveReportTimezone(configuredOptions.timezone);
  const resolved = resolveTrendsOptions(configuredOptions, timezone, now);
  const datasetOptions = {
    ...configuredOptions,
    timezone,
    since: resolved.fetchDateRange?.from ?? configuredOptions.since,
    until: resolved.fetchDateRange?.to ?? configuredOptions.until,
  };
  // Spike days need the cost of the days before the chart.
  const lookbackSince =
    resolved.fetchDateRange && resolved.metric === 'cost'
      ? resolveSpikeBaselineStart(resolved.fetchDateRange.from)
      : undefined;
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'trends.dataset.total',
    () =>
      buildUsageEventDataset(
        datasetOptions,
        {
          ...deps,
          userConfigResolution: {
            ...userConfigResolution,
            options: datasetOptions,
          },
        },
        { lookbackSince },
      ),
  );
  const pricingResult =
    resolved.metric === 'cost'
      ? await applyPricingToUsageEventDataset(dataset, deps, 'auto', {
          events: [...dataset.filteredEvents, ...dataset.lookbackEvents],
        })
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
  // Priced cost events end with the spike check's lookback days; the rest of the report
  // reads the chart's days only.
  const chartedEvents = pricingResult.pricedEvents.slice(0, dataset.filteredEvents.length);
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
  const diagnostics = buildDatasetDiagnostics(dataset, {
    pricing: pricingResult,
    // Only cost trends show `~`, and only for the days in the chart.
    notes: [
      ...withPricingNotes(
        dataset.notes,
        resolved.metric === 'cost' ? chartedEvents : [],
        pricingResult,
      ),
      ...(resolved.metric === 'active-hours' ? listSingleEventSourceNotes(chartedEvents) : []),
    ],
    runtimeProfile: deps.runtimeProfile,
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
