import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import { buildEventProjectLabels } from '../aggregate/project-key.js';
import type { UsageReportRow } from '../domain/usage-report-row.js';
import {
  getCurrentLocalDateKey,
  getIsoDayOfWeekFromDateKey,
  getLocalHourBucket,
  shiftLocalDateKey,
  type ReportGranularity,
  type UsageGranularity,
} from '../utils/time-buckets.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import { normalizeBuildUsageInputs } from './build-usage-data-inputs.js';
import { assembleUsageDataResult, buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  applyPricingToUsageEventDataset,
  withPricingNotes,
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

/** Days `daily` and the day-window reports (`blocks`, `tools`, `context`) cover without dates. */
export const DEFAULT_RECENT_DAYS = 7;

/**
 * Granularities that report a recent window when no dates are given. `monthly` keeps full
 * history.
 */
export const DEFAULT_REPORT_WINDOWS: Partial<Record<ReportGranularity, DefaultReportWindow>> = {
  daily: { periods: DEFAULT_RECENT_DAYS, period: 'day' },
  weekly: { periods: 8, period: 'week' },
};

const MAX_LAST_PERIODS = 10_000;

/** `hourly --last N` covers at most this many days. */
export const HOURLY_MAX_LAST_DAYS = 31;

export function parseLastOption(
  last: string | undefined,
  flag = '--last',
  maxPeriods = MAX_LAST_PERIODS,
): number | undefined {
  if (last === undefined) {
    return undefined;
  }

  const normalized = last.trim();
  const periods = Number.parseInt(normalized, 10);

  if (!/^[1-9]\d*$/u.test(normalized) || periods > maxPeriods) {
    throw new Error(`${flag} must be a whole number from 1 to ${String(maxPeriods)}`);
  }

  return periods;
}

/**
 * First local date key of the `periods` periods that end with the one containing `today`.
 * Weeks start on Monday, matching the weekly buckets.
 */
export function resolvePeriodsSince(
  granularity: UsageGranularity,
  today: string,
  periods: number,
): string {
  switch (granularity) {
    case 'hourly':
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

/** Without dates, `hourly` covers today. */
const HOURLY_DEFAULT_DAYS = 1;

function getDefaultWindowPeriods(granularity: UsageGranularity): number | undefined {
  return granularity === 'hourly'
    ? HOURLY_DEFAULT_DAYS
    : DEFAULT_REPORT_WINDOWS[granularity]?.periods;
}

/**
 * `--last N` covers the last N periods, counting the current one, in the report timezone
 * (days for `hourly`). Without dates, `hourly` and a granularity with a
 * DEFAULT_REPORT_WINDOWS entry cover that recent window; `--all` restores full history.
 * Explicit dates and other granularities are unchanged.
 */
export async function resolveUsageDataRequest(
  granularity: UsageGranularity,
  options: ReportCommandOptions,
  deps: BuildUsageDataDeps,
): Promise<UsageDataRequest> {
  const hasDates = options.since !== undefined || options.until !== undefined;
  const isHourly = granularity === 'hourly';
  const lastPeriods = parseLastOption(
    options.last,
    '--last',
    isHourly ? HOURLY_MAX_LAST_DAYS : undefined,
  );

  if (lastPeriods !== undefined && (hasDates || options.all)) {
    throw new Error(
      isHourly
        ? '--last cannot be combined with --since or --until'
        : '--last cannot be combined with --since, --until, or --all',
    );
  }

  if (options.all && hasDates) {
    throw new Error('--all cannot be combined with --since or --until');
  }

  const periods =
    lastPeriods ?? (options.all || hasDates ? undefined : getDefaultWindowPeriods(granularity));

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
  // `--last` and hourly's default window also end today, so events dated later (a clock
  // set ahead) stay out. The other default windows keep no upper bound.
  const windowedOptions = {
    ...userConfigResolution.options,
    since,
    ...(lastPeriods === undefined && !isHourly ? {} : { until: today }),
  };

  return {
    options: windowedOptions,
    deps: { ...deps, userConfigResolution: { ...userConfigResolution, options: windowedOptions } },
    ...(lastPeriods === undefined ? { defaultWindowSince: since } : {}),
  };
}

/**
 * The hourly keys that combine two occurrences of a local hour (a DST fall-back), sorted.
 */
export function findRepeatedLocalHours(
  events: readonly { timestamp: string }[],
  timezone: string,
): string[] {
  const offsetByKey = new Map<string, number>();
  const repeated = new Set<string>();

  for (const event of events) {
    const { key, offsetMs } = getLocalHourBucket(event.timestamp, timezone);
    const seenOffsetMs = offsetByKey.get(key);

    if (seenOffsetMs === undefined) {
      offsetByKey.set(key, offsetMs);
    } else if (seenOffsetMs !== offsetMs) {
      repeated.add(key);
    }
  }

  return [...repeated].sort();
}

/** Flags the rows of a fall-back hour whose events fall on both of its occurrences. */
function markRepeatedHourRows(
  rows: UsageReportRow[],
  events: readonly { timestamp: string }[],
  timezone: string,
): UsageReportRow[] {
  const repeatedKeys = new Set(findRepeatedLocalHours(events, timezone));

  if (repeatedKeys.size === 0) {
    return rows;
  }

  return rows.map((row) =>
    row.rowType !== 'grand_total' && repeatedKeys.has(row.periodKey)
      ? { ...row, repeatedHour: true }
      : row,
  );
}

export async function buildUsageData(
  granularity: UsageGranularity,
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
  // --no-cost shows no cost, so prices are neither loaded nor fetched.
  const pricingResult = await applyPricingToUsageEventDataset(
    dataset,
    deps,
    options.cost === false ? 'none' : 'auto',
  );
  const { pricedEvents, pricingOrigin, pricingWarning } = pricingResult;

  const byRepo = options.byRepo === true;
  const rows = measureRuntimeProfileStageSync(deps.runtimeProfile, 'usage.aggregate', () =>
    aggregateUsage(pricedEvents, {
      granularity,
      timezone: dataset.normalizedInputs.timezone,
      sourceOrder: dataset.adaptersToParse.map((adapter) => adapter.id),
      split: { machine: options.byMachine === true, repo: byRepo },
      ...(byRepo
        ? {
            projectLabels: buildEventProjectLabels(pricedEvents),
          }
        : {}),
    }),
  );

  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    warnings: dataset.warnings,
    notes:
      options.cost === false
        ? dataset.notes
        : withPricingNotes(dataset.notes, pricedEvents, pricingResult),
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  const result = assembleUsageDataResult(
    pricedEvents,
    granularity === 'hourly'
      ? markRepeatedHourRows(rows, pricedEvents, dataset.normalizedInputs.timezone)
      : rows,
    diagnostics,
  );
  return defaultWindowSince ? { ...result, defaultWindowSince } : result;
}
