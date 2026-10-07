import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import {
  getCurrentLocalDateKey,
  getIsoDayOfWeekFromDateKey,
  shiftLocalDateKey,
  type ReportGranularity,
} from '../utils/time-buckets.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import { normalizeBuildUsageInputs } from './build-usage-data-inputs.js';
import { assembleUsageDataResult, buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildUsageDataDeps,
  ReportCommandOptions,
  UsageDataResult,
} from './usage-data-contracts.js';

type DefaultReportWindow = {
  periods: number;
  period: 'day' | 'week';
  /** First local date key of the window that ends with the period containing `today`. */
  resolveSince: (today: string) => string;
};

const DAILY_DEFAULT_DAYS = 7;
const WEEKLY_DEFAULT_WEEKS = 8;

/**
 * Granularities that report a recent window when no dates are given. `monthly` keeps full
 * history. Weeks start on Monday, matching the weekly buckets.
 */
export const DEFAULT_REPORT_WINDOWS: Partial<Record<ReportGranularity, DefaultReportWindow>> = {
  daily: {
    periods: DAILY_DEFAULT_DAYS,
    period: 'day',
    resolveSince: (today) => shiftLocalDateKey(today, -(DAILY_DEFAULT_DAYS - 1)),
  },
  weekly: {
    periods: WEEKLY_DEFAULT_WEEKS,
    period: 'week',
    resolveSince: (today) => {
      const currentWeekMonday = shiftLocalDateKey(today, -(getIsoDayOfWeekFromDateKey(today) - 1));
      return shiftLocalDateKey(currentWeekMonday, -7 * (WEEKLY_DEFAULT_WEEKS - 1));
    },
  },
};

type UsageDataRequest = {
  options: ReportCommandOptions;
  deps: BuildUsageDataDeps;
  defaultWindowSince?: string;
};

/**
 * A granularity with a DEFAULT_REPORT_WINDOWS entry covers that recent window in the report
 * timezone when no dates are given; `--all` restores full history. Explicit dates and other
 * granularities are unchanged.
 */
async function resolveUsageDataRequest(
  granularity: ReportGranularity,
  options: ReportCommandOptions,
  deps: BuildUsageDataDeps,
): Promise<UsageDataRequest> {
  if (options.all && (options.since !== undefined || options.until !== undefined)) {
    throw new Error('--all cannot be combined with --since or --until');
  }

  const defaultWindow = DEFAULT_REPORT_WINDOWS[granularity];

  if (!defaultWindow || options.all || options.since !== undefined || options.until !== undefined) {
    return { options, deps };
  }

  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const { timezone } = normalizeBuildUsageInputs(userConfigResolution.options);
  const today = getCurrentLocalDateKey(timezone, deps.now?.() ?? new Date());
  const since = defaultWindow.resolveSince(today);
  const windowedOptions = { ...userConfigResolution.options, since };

  return {
    options: windowedOptions,
    deps: { ...deps, userConfigResolution: { ...userConfigResolution, options: windowedOptions } },
    defaultWindowSince: since,
  };
}

export async function buildUsageData(
  granularity: ReportGranularity,
  commandOptions: ReportCommandOptions,
  commandDeps: BuildUsageDataDeps = {},
): Promise<UsageDataResult> {
  const { options, deps, defaultWindowSince } = await resolveUsageDataRequest(
    granularity,
    commandOptions,
    commandDeps,
  );
  const dataset = await measureRuntimeProfileStage(deps.runtimeProfile, 'usage.dataset.total', () =>
    buildUsageEventDataset(options, deps),
  );
  const { pricedEvents, pricingOrigin, pricingWarning } = await applyPricingToUsageEventDataset(
    dataset,
    deps,
    'auto',
  );

  const rows = measureRuntimeProfileStageSync(deps.runtimeProfile, 'usage.aggregate', () =>
    aggregateUsage(pricedEvents, {
      granularity,
      timezone: dataset.normalizedInputs.timezone,
      sourceOrder: dataset.adaptersToParse.map((adapter) => adapter.id),
    }),
  );

  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    warnings: dataset.warnings,
    notes: dataset.notes,
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  const result = assembleUsageDataResult(pricedEvents, rows, diagnostics);
  return defaultWindowSince ? { ...result, defaultWindowSince } : result;
}
