import { aggregateWrapped } from '../wrapped/aggregate-wrapped.js';
import { getCurrentLocalDateKey } from '../utils/time-buckets.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { validateTimezone } from './build-usage-data-inputs.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildWrappedDataDeps,
  WrappedCommandOptions,
  WrappedDataResult,
} from './usage-data-contracts.js';

export function parseWrappedYearOption(year: string | undefined): number | undefined {
  if (year === undefined) {
    return undefined;
  }

  const normalized = year.trim();
  const parsed = Number.parseInt(normalized, 10);

  if (!/^\d{4}$/u.test(normalized) || Number.isNaN(parsed) || parsed < 2020 || parsed > 2100) {
    throw new Error('--year must be a four-digit year between 2020 and 2100');
  }

  return parsed;
}

function getWrappedYearRange(year: number): { from: string; to: string } {
  return {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  };
}

function resolveWrappedYear(year: string | undefined, timezone: string, now: Date): number {
  const parsedYear = parseWrappedYearOption(year);

  if (parsedYear !== undefined) {
    return parsedYear;
  }

  return Number.parseInt(getCurrentLocalDateKey(timezone, now).slice(0, 4), 10);
}

export async function buildWrappedData(
  options: WrappedCommandOptions,
  deps: BuildWrappedDataDeps = {},
): Promise<WrappedDataResult> {
  const now = deps.now?.() ?? new Date();
  const timezone = options.timezone?.trim() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  validateTimezone(timezone);
  const year = resolveWrappedYear(options.year, timezone, now);
  const range = getWrappedYearRange(year);
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'wrapped.dataset.total',
    () =>
      buildUsageEventDataset(
        {
          ...options,
          timezone,
          since: range.from,
          until: range.to,
        },
        deps,
      ),
  );
  const { pricedEvents, pricingOrigin, pricingWarning } = await applyPricingToUsageEventDataset(
    dataset,
    deps,
    'auto',
  );
  const recap = measureRuntimeProfileStageSync(deps.runtimeProfile, 'wrapped.aggregate', () =>
    aggregateWrapped(pricedEvents, {
      year,
      timezone: dataset.normalizedInputs.timezone,
    }),
  );
  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  return {
    recap,
    diagnostics,
  };
}
