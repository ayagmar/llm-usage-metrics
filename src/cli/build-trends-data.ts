import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import { buildEventProjectLabels, toProjectKey } from '../aggregate/project-key.js';
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

// Per-day gap-capped active time: group a day's events by session, run
// computeActiveMs per group, and sum per source (or per project). A session crossing
// midnight splits at the day boundary; with --by-repo, a session that moves between
// projects splits at each project.
function sumActiveMsByDay<Group>(
  events: readonly UsageEvent[],
  timezone: string,
  groupOf: (event: UsageEvent) => Group,
): { periodKey: string; group: Group; value: number }[] {
  const timestampsByDate = new Map<string, Map<Group, Map<string, number[]>>>();

  for (const event of events) {
    const timestampMs = Date.parse(event.timestamp);

    if (Number.isNaN(timestampMs)) {
      continue;
    }

    const dateKey = getPeriodKey(event.timestamp, 'daily', timezone);
    const groups = timestampsByDate.get(dateKey) ?? new Map<Group, Map<string, number[]>>();
    const group = groupOf(event);
    const sessions = groups.get(group) ?? new Map<string, number[]>();
    const sessionKey = getEventSessionKey(event);
    const timestampsMs = sessions.get(sessionKey) ?? [];
    timestampsMs.push(timestampMs);
    sessions.set(sessionKey, timestampsMs);
    groups.set(group, sessions);
    timestampsByDate.set(dateKey, groups);
  }

  const rows: { periodKey: string; group: Group; value: number }[] = [];

  for (const [periodKey, groups] of timestampsByDate) {
    for (const [group, sessions] of groups) {
      let activeMs = 0;

      for (const timestampsMs of sessions.values()) {
        activeMs += computeActiveMs(timestampsMs);
      }

      rows.push({ periodKey, group, value: activeMs });
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
  const trends = measureRuntimeProfileStageSync(deps.runtimeProfile, 'trends.aggregate', () =>
    aggregateTrends(filterRowsToDateRange(dailyValueRows, outputDateRange), {
      dateRange: outputDateRange,
      bySource: options.bySource === true,
      sourceOrder: dataset.adaptersToParse.map((adapter) => adapter.id),
    }),
  );
  const projectSeries = options.byRepo
    ? measureRuntimeProfileStageSync(deps.runtimeProfile, 'trends.aggregate_projects', () => {
        // One label set over the whole range, so a project keeps its label on every day.
        const projectLabels = buildEventProjectLabels(dataset.filteredEvents);
        const projectRows =
          resolved.metric === 'active-hours'
            ? toActiveTimeProjectValueRows(
                dataset.filteredEvents,
                dataset.normalizedInputs.timezone,
                projectLabels,
              )
            : toProjectTrendValueRows(
                aggregateUsage(pricingResult.pricedEvents, {
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
  // Only cost trends show `~`, and only for the days in the chart.
  const chartedEvents =
    resolved.metric === 'cost'
      ? pricingResult.pricedEvents.filter((event) => {
          const day = getPeriodKey(event.timestamp, 'daily', dataset.normalizedInputs.timezone);
          return day >= outputDateRange.from && day <= outputDateRange.to;
        })
      : [];
  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin: pricingResult.pricingOrigin,
    pricingWarning: pricingResult.pricingWarning,
    warnings: dataset.warnings,
    notes: withPricingNotes(dataset.notes, chartedEvents, pricingResult),
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
