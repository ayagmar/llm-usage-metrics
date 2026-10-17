import { aggregateDailyActivity, resolveActivityStart } from '../aggregate/daily-activity.js';
import { LOCAL_MACHINE_NAME, type UsageEvent } from '../domain/usage-event.js';
import { estimateCacheSavingsUsd } from '../pricing/cache-savings.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getCurrentLocalDateKey, shiftLocalDateKey } from '../utils/time-buckets.js';
import { resolveUserConfigForOptions, type UserConfigResolution } from './apply-user-config.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { normalizeBuildUsageInputs } from './build-usage-data-inputs.js';
import {
  applyPricingToUsageEventDataset,
  withPricingNotes,
  buildUsageEventDataset,
  type UsageEventDataset,
} from './build-usage-event-dataset.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildSummaryDataDeps,
  SummaryCommandOptions,
  SummaryDataResult,
  SummaryMachineTotals,
  SummaryMonthEnd,
  SummaryPeriod,
  SummaryPeriodKey,
  SummarySourceTotals,
  UsageWindowTotals,
} from './usage-data-contracts.js';
import {
  createWindowEventFilter,
  summarizeUsageWindow,
  type UsageDateWindow,
} from './usage-window-summary.js';

export type SummaryWindow = UsageDateWindow & {
  key: SummaryPeriodKey;
  label: string;
};

const SUMMARY_RECENT_DAYS = 7;

export function resolveSummaryWindows(timezone: string, now: Date): SummaryWindow[] {
  const today = getCurrentLocalDateKey(timezone, now);

  return [
    { key: 'today', label: 'Today', since: today, until: today },
    {
      key: 'last7Days',
      label: `Last ${SUMMARY_RECENT_DAYS} days`,
      since: shiftLocalDateKey(today, -(SUMMARY_RECENT_DAYS - 1)),
      until: today,
    },
    { key: 'monthToDate', label: 'Month to date', since: `${today.slice(0, 8)}01`, until: today },
  ];
}

// Two days of usage are too few to scale to a month.
const MIN_PROJECTION_DAYS = 3;

export function resolveMonthEnd(
  today: string,
  monthToDate: Pick<SummaryPeriod, 'totals'> | undefined,
  budgetUsd: number | undefined,
): SummaryMonthEnd {
  const daysElapsed = Number(today.slice(8, 10));
  const daysInMonth = new Date(
    Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0),
  ).getUTCDate();
  const costUsd = monthToDate?.totals.costUsd;
  const monthEnd: SummaryMonthEnd = { daysElapsed, daysInMonth };
  const hasUsage = (monthToDate?.totals.events ?? 0) > 0;

  if (hasUsage && costUsd !== undefined && daysElapsed >= MIN_PROJECTION_DAYS) {
    monthEnd.projectedCostUsd = (costUsd / daysElapsed) * daysInMonth;

    if (monthToDate?.totals.costIncomplete) {
      monthEnd.costIncomplete = true;
    }
  }

  if (budgetUsd !== undefined) {
    monthEnd.budgetUsd = budgetUsd;
  }

  return monthEnd;
}

/**
 * Unlike `hasCliFilters` (filter-match-warnings.ts), dates are not counted: the summary has
 * no date flags, and this only decides whether the monthly budget applies.
 *
 * The budget covers all usage, so a run narrowed by --source, --provider, --model, or
 * --repo cannot be measured against it. A `sources` list in the config file is the user's
 * standing view, not a narrowing, so it keeps the budget.
 */
function isNarrowedByCliFilters(cliOptions: SummaryCommandOptions): boolean {
  const source = cliOptions.source;
  const model = cliOptions.model;
  const repo = cliOptions.repo;
  const hasSource = Array.isArray(source) ? source.length > 0 : Boolean(source);
  const hasModel = Array.isArray(model) ? model.length > 0 : Boolean(model);
  const hasRepo = Array.isArray(repo) ? repo.length > 0 : Boolean(repo);

  return hasSource || hasModel || hasRepo || Boolean(cliOptions.provider);
}

/** The config's monthly budget, unless CLI filters narrow the run. */
export function resolveMonthlyBudgetUsd(
  userConfigResolution: UserConfigResolution,
): number | undefined {
  return isNarrowedByCliFilters(userConfigResolution.cliOptions)
    ? undefined
    : userConfigResolution.loadedConfig.config.monthlyBudgetUsd;
}

function compareByCost(left: UsageWindowTotals, right: UsageWindowTotals): number {
  const costDelta = (right.costUsd ?? 0) - (left.costUsd ?? 0);

  if (costDelta !== 0) {
    return costDelta;
  }

  return right.totalTokens - left.totalTokens;
}

function compareSourcesByCost(left: SummarySourceTotals, right: SummarySourceTotals): number {
  return compareByCost(left, right) || compareByCodePoint(left.source, right.source);
}

function compareMachinesByCost(left: SummaryMachineTotals, right: SummaryMachineTotals): number {
  return compareByCost(left, right) || compareByCodePoint(left.machine, right.machine);
}

function summarizeMachines(
  events: UsageEvent[],
  timezone: string,
  sourceOrder: string[],
): SummaryMachineTotals[] {
  const eventsByMachine = new Map<string, UsageEvent[]>();

  for (const event of events) {
    const machine = event.machine ?? LOCAL_MACHINE_NAME;
    const machineEvents = eventsByMachine.get(machine) ?? [];
    machineEvents.push(event);
    eventsByMachine.set(machine, machineEvents);
  }

  return [...eventsByMachine]
    .map(([machine, machineEvents]) => ({
      machine,
      ...summarizeUsageWindow(machineEvents, timezone, sourceOrder).totals,
    }))
    .sort(compareMachinesByCost);
}

export type SummaryDataset = {
  userConfigResolution: UserConfigResolution;
  timezone: string;
  windows: SummaryWindow[];
  today: string;
  /** First day of the activity grid, a year back, which covers every summary window. */
  since: string;
  dataset: UsageEventDataset;
};

/** The unpriced events of the summary's year, shared by the summary and the statusline. */
export async function buildSummaryDataset(
  options: SummaryCommandOptions,
  deps: BuildSummaryDataDeps = {},
): Promise<SummaryDataset> {
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options;
  const { timezone } = normalizeBuildUsageInputs(
    configuredOptions,
    userConfigResolution.cliOptions,
  );
  const windows = resolveSummaryWindows(timezone, deps.now?.() ?? new Date());
  const today = windows[0].until;
  const since = resolveActivityStart(today);
  const datasetOptions = { ...configuredOptions, since, until: today, timezone };
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'summary.dataset.total',
    () =>
      buildUsageEventDataset(datasetOptions, {
        ...deps,
        userConfigResolution: { ...userConfigResolution, options: datasetOptions },
      }),
  );

  return { userConfigResolution, timezone, windows, today, since, dataset };
}

export async function buildSummaryData(
  options: SummaryCommandOptions,
  deps: BuildSummaryDataDeps = {},
): Promise<SummaryDataResult> {
  const { userConfigResolution, timezone, windows, today, since, dataset } =
    await buildSummaryDataset(options, deps);
  const pricingResult = await applyPricingToUsageEventDataset(dataset, deps, 'cache-savings');
  const { pricedEvents, pricingOrigin, pricingWarning, pricingSource } = pricingResult;
  const sourceOrder = dataset.adaptersToParse.map((adapter) => adapter.id);
  // Other machines' events carry their name; this machine's carry none.
  const countsOtherMachines = pricedEvents.some((event) => event.machine !== undefined);
  const eventsByWindow = new Map<SummaryPeriodKey, UsageEvent[]>();
  const periods = measureRuntimeProfileStageSync(deps.runtimeProfile, 'summary.aggregate', () =>
    windows.map((window): SummaryPeriod => {
      const windowEvents = pricedEvents.filter(createWindowEventFilter(window, timezone));
      eventsByWindow.set(window.key, windowEvents);
      const summary = summarizeUsageWindow(windowEvents, timezone, sourceOrder);
      const period: SummaryPeriod = {
        key: window.key,
        label: window.label,
        since: window.since,
        until: window.until,
        totals: summary.totals,
        sources: [...summary.sources]
          .map(([source, totals]) => ({ source, ...totals }))
          .sort(compareSourcesByCost),
      };

      if (countsOtherMachines) {
        period.machines = summarizeMachines(windowEvents, timezone, sourceOrder);
      }

      return period;
    }),
  );

  const activity = measureRuntimeProfileStageSync(deps.runtimeProfile, 'summary.activity', () =>
    aggregateDailyActivity(pricedEvents, { from: since, to: today, timezone }),
  );

  const monthToDate = periods.find((period) => period.key === 'monthToDate');
  const monthToDateEvents = eventsByWindow.get('monthToDate');
  const monthToDateCacheSavingsUsd =
    pricingSource && monthToDateEvents
      ? estimateCacheSavingsUsd(monthToDateEvents, pricingSource, pricingResult.pricingPolicy)
      : undefined;

  // The `~` marks only appear on the windows and on the best day's cost. Every window ends
  // today, so together they span one range from the earliest window start.
  const bestDay = activity.bestDay?.costUsd === undefined ? undefined : activity.bestDay.date;
  const isInSomeWindow = createWindowEventFilter(
    {
      since: windows.reduce(
        (earliest, window) => (window.since < earliest ? window.since : earliest),
        today,
      ),
      until: today,
    },
    timezone,
  );
  const isOnBestDay = bestDay
    ? createWindowEventFilter({ since: bestDay, until: bestDay }, timezone)
    : () => false;
  const shownCostEvents = pricedEvents.filter(
    (event) => isInSomeWindow(event) || isOnBestDay(event),
  );

  return {
    timezone,
    periods,
    monthEnd: resolveMonthEnd(today, monthToDate, resolveMonthlyBudgetUsd(userConfigResolution)),
    monthToDateCacheSavingsUsd,
    activity,
    diagnostics: buildUsageDiagnostics({
      adaptersToParse: dataset.adaptersToParse,
      successfulParseResults: dataset.successfulParseResults,
      sourceFailures: dataset.sourceFailures,
      pricingOrigin,
      pricingWarning,
      warnings: dataset.warnings,
      notes: withPricingNotes(dataset.notes, shownCostEvents, pricingResult),
      activeEnvOverrides: dataset.readEnvVarOverrides(),
      activeConfig: dataset.activeConfig,
      timezone,
      runtimeProfile: deps.runtimeProfile?.snapshot(),
    }),
  };
}
