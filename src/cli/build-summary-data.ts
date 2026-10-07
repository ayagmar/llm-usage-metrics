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
  SummaryPeriod,
  SummaryPeriodKey,
  SummarySourceTotals,
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

export const SUMMARY_RECENT_DAYS = 7;

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

function compareSourcesByCost(left: SummarySourceTotals, right: SummarySourceTotals): number {
  const costDelta = (right.costUsd ?? 0) - (left.costUsd ?? 0);

  if (costDelta !== 0) {
    return costDelta;
  }

  if (left.totalTokens !== right.totalTokens) {
    return right.totalTokens - left.totalTokens;
  }

  return compareByCodePoint(left.source, right.source);
}

export async function buildSummaryData(
  options: SummaryCommandOptions,
  deps: BuildSummaryDataDeps = {},
): Promise<SummaryDataResult> {
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options;
  const { timezone } = normalizeBuildUsageInputs(configuredOptions);
  const windows = resolveSummaryWindows(timezone, deps.now?.() ?? new Date());
  const since = windows.reduce(
    (earliest, window) => (window.since < earliest ? window.since : earliest),
    windows[0].since,
  );
  const datasetOptions = { ...configuredOptions, since, until: windows[0].until, timezone };
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'summary.dataset.total',
    () =>
      buildUsageEventDataset(datasetOptions, {
        ...deps,
        userConfigResolution: { ...userConfigResolution, options: datasetOptions },
      }),
  );
  const { pricedEvents, pricingOrigin, pricingWarning } = await applyPricingToUsageEventDataset(
    dataset,
    deps,
    'auto',
  );
  const sourceOrder = dataset.adaptersToParse.map((adapter) => adapter.id);
  const periods = measureRuntimeProfileStageSync(deps.runtimeProfile, 'summary.aggregate', () =>
    windows.map((window): SummaryPeriod => {
      const summary = summarizeUsageWindow(
        pricedEvents.filter((event) => isEventWithinWindow(event, window, timezone)),
        timezone,
        sourceOrder,
      );

      return {
        key: window.key,
        label: window.label,
        since: window.since,
        until: window.until,
        totals: summary.totals,
        sources: [...summary.sources]
          .map(([source, totals]) => ({ source, ...totals }))
          .sort(compareSourcesByCost),
      };
    }),
  );

  return {
    timezone,
    periods,
    diagnostics: buildUsageDiagnostics({
      adaptersToParse: dataset.adaptersToParse,
      successfulParseResults: dataset.successfulParseResults,
      sourceFailures: dataset.sourceFailures,
      pricingOrigin,
      pricingWarning,
      warnings: dataset.warnings,
      activeEnvOverrides: dataset.readEnvVarOverrides(),
      activeConfig: dataset.activeConfig,
      timezone,
      runtimeProfile: deps.runtimeProfile?.snapshot(),
    }),
  };
}
