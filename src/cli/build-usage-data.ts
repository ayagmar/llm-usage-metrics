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

type ReportPeriodName = 'day' | 'week' | 'month';

const REPORT_PERIOD_NAMES: Record<ReportGranularity, ReportPeriodName> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
};

type DefaultReportWindow = {
  periods: number;
  period: ReportPeriodName;
};

/**
 * Granularities that report a recent window when no dates are given. `monthly` keeps full
 * history.
 */
export const DEFAULT_REPORT_WINDOWS: Partial<Record<ReportGranularity, DefaultReportWindow>> = {
  daily: { periods: 7, period: 'day' },
  weekly: { periods: 8, period: 'week' },
};

const MAX_LAST_PERIODS = 10_000;

function parseLastOption(last: string | undefined): number | undefined {
  if (last === undefined) {
    return undefined;
  }

  const normalized = last.trim();
  const periods = Number.parseInt(normalized, 10);

  if (!/^[1-9]\d*$/u.test(normalized) || periods > MAX_LAST_PERIODS) {
    throw new Error(`--last must be a whole number from 1 to ${String(MAX_LAST_PERIODS)}`);
  }

  return periods;
}

/**
 * First local date key of the `periods` periods that end with the one containing `today`.
 * Weeks start on Monday, matching the weekly buckets.
 */
export function resolvePeriodsSince(
  granularity: ReportGranularity,
  today: string,
  periods: number,
): string {
  switch (granularity) {
    case 'daily':
      return shiftLocalDateKey(today, -(periods - 1));
    case 'weekly': {
      const currentWeekMonday = shiftLocalDateKey(today, -(getIsoDayOfWeekFromDateKey(today) - 1));
      return shiftLocalDateKey(currentWeekMonday, -7 * (periods - 1));
    }
    case 'monthly': {
      const monthIndex =
        Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 - (periods - 1);
      const year = String(Math.floor(monthIndex / 12)).padStart(4, '0');
      const month = String((monthIndex % 12) + 1).padStart(2, '0');
      return `${year}-${month}-01`;
    }
  }
}

export function getReportPeriodName(granularity: ReportGranularity): ReportPeriodName {
  return REPORT_PERIOD_NAMES[granularity];
}

type UsageDataRequest = {
  options: ReportCommandOptions;
  deps: BuildUsageDataDeps;
  defaultWindowSince?: string;
};

/**
 * `--last N` covers the last N periods, counting the current one, in the report timezone.
 * Without dates, a granularity with a DEFAULT_REPORT_WINDOWS entry covers that recent
 * window; `--all` restores full history. Explicit dates and other granularities are unchanged.
 */
async function resolveUsageDataRequest(
  granularity: ReportGranularity,
  options: ReportCommandOptions,
  deps: BuildUsageDataDeps,
): Promise<UsageDataRequest> {
  const hasDates = options.since !== undefined || options.until !== undefined;
  const lastPeriods = parseLastOption(options.last);

  if (lastPeriods !== undefined && (hasDates || options.all)) {
    throw new Error('--last cannot be combined with --since, --until, or --all');
  }

  if (options.all && hasDates) {
    throw new Error('--all cannot be combined with --since or --until');
  }

  const periods =
    lastPeriods ??
    (options.all || hasDates ? undefined : DEFAULT_REPORT_WINDOWS[granularity]?.periods);

  if (periods === undefined) {
    return { options, deps };
  }

  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const { timezone } = normalizeBuildUsageInputs(
    userConfigResolution.options,
    userConfigResolution.cliOptions,
  );
  const today = getCurrentLocalDateKey(timezone, deps.now?.() ?? new Date());
  const since = resolvePeriodsSince(granularity, today, periods);
  const windowedOptions = { ...userConfigResolution.options, since };

  return {
    options: windowedOptions,
    deps: { ...deps, userConfigResolution: { ...userConfigResolution, options: windowedOptions } },
    ...(lastPeriods === undefined ? { defaultWindowSince: since } : {}),
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
      byMachine: options.byMachine === true,
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
