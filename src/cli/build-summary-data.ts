import { aggregateDailyActivity, resolveActivityStart } from '../aggregate/daily-activity.js';
import { LOCAL_MACHINE_NAME, type UsageEvent } from '../domain/usage-event.js';
import { estimateCacheSavingsUsd } from '../pricing/cache-savings.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getCurrentLocalDateKey, shiftLocalDateKey } from '../utils/time-buckets.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { normalizeBuildUsageInputs } from './build-usage-data-inputs.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
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
  isEventWithinWindow,
  summarizeUsageWindow,
  type UsageDateWindow,
} from './usage-window-summary.js';

type SummaryWindow = UsageDateWindow & {
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
  monthToDate: SummaryPeriod | undefined,
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
 * The budget covers all usage, so a run narrowed by --source, --provider, or --model
 * cannot be measured against it. A `sources` list in the config file is the user's
 * standing view, not a narrowing, so it keeps the budget.
 */
function isNarrowedByCliFilters(cliOptions: SummaryCommandOptions): boolean {
  const source = cliOptions.source;
  const model = cliOptions.model;
  const hasSource = Array.isArray(source) ? source.length > 0 : Boolean(source);
  const hasModel = Array.isArray(model) ? model.length > 0 : Boolean(model);

  return hasSource || hasModel || Boolean(cliOptions.provider);
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

export async function buildSummaryData(
  options: SummaryCommandOptions,
  deps: BuildSummaryDataDeps = {},
): Promise<SummaryDataResult> {
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options;
  const { timezone } = normalizeBuildUsageInputs(
    configuredOptions,
    userConfigResolution.cliOptions,
  );
  const windows = resolveSummaryWindows(timezone, deps.now?.() ?? new Date());
  const today = windows[0].until;
  // The activity grid reaches back a year, which covers every summary window.
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
  const { pricedEvents, pricingOrigin, pricingWarning, pricingSource } =
    await applyPricingToUsageEventDataset(dataset, deps, 'auto');
  const sourceOrder = dataset.adaptersToParse.map((adapter) => adapter.id);
  // Other machines' events carry their name; this machine's carry none.
  const countsOtherMachines = pricedEvents.some((event) => event.machine !== undefined);
  const periods = measureRuntimeProfileStageSync(deps.runtimeProfile, 'summary.aggregate', () =>
    windows.map((window): SummaryPeriod => {
      const windowEvents = pricedEvents.filter((event) =>
        isEventWithinWindow(event, window, timezone),
      );
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
  const monthToDateWindow = windows.find((window) => window.key === 'monthToDate');
  const monthToDateCacheSavingsUsd =
    pricingSource && monthToDateWindow
      ? estimateCacheSavingsUsd(
          pricedEvents.filter((event) => isEventWithinWindow(event, monthToDateWindow, timezone)),
          pricingSource,
        )
      : undefined;

  return {
    timezone,
    periods,
    monthEnd: resolveMonthEnd(
      today,
      monthToDate,
      isNarrowedByCliFilters(userConfigResolution.cliOptions)
        ? undefined
        : userConfigResolution.loadedConfig.config.monthlyBudgetUsd,
    ),
    monthToDateCacheSavingsUsd,
    activity,
    diagnostics: buildUsageDiagnostics({
      adaptersToParse: dataset.adaptersToParse,
      successfulParseResults: dataset.successfulParseResults,
      sourceFailures: dataset.sourceFailures,
      pricingOrigin,
      pricingWarning,
      warnings: dataset.warnings,
      notes: dataset.notes,
      activeEnvOverrides: dataset.readEnvVarOverrides(),
      activeConfig: dataset.activeConfig,
      timezone,
      runtimeProfile: deps.runtimeProfile?.snapshot(),
    }),
  };
}
