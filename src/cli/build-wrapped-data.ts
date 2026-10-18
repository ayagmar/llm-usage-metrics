import { estimateCacheSavingsUsd } from '../pricing/cache-savings.js';
import { aggregateWrapped, getYearDateRange } from '../wrapped/aggregate-wrapped.js';
import { getCurrentLocalDateKey } from '../utils/time-buckets.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { resolveReportTimezone } from './build-usage-data-inputs.js';
import {
  applyPricingToUsageEventDataset,
  withPricingNotes,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
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
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options as WrappedCommandOptions;
  const now = deps.now?.() ?? new Date();
  const timezone = resolveReportTimezone(configuredOptions.timezone);
  const year = resolveWrappedYear(configuredOptions.year, timezone, now);
  const range = getYearDateRange(year);
  const datasetOptions = {
    ...configuredOptions,
    timezone,
    since: range.from,
    until: range.to,
  };
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'wrapped.dataset.total',
    () =>
      buildUsageEventDataset(datasetOptions, {
        ...deps,
        userConfigResolution: {
          ...userConfigResolution,
          options: datasetOptions,
        },
      }),
  );
  const pricingResult = await applyPricingToUsageEventDataset(dataset, deps, 'cache-savings');
  const { pricedEvents, pricingOrigin, pricingWarning, pricingSource } = pricingResult;
  const recap = measureRuntimeProfileStageSync(deps.runtimeProfile, 'wrapped.aggregate', () =>
    aggregateWrapped(pricedEvents, {
      year,
      timezone: dataset.normalizedInputs.timezone,
    }),
  );

  // The dataset is already year-filtered via since/until above, so the same
  // events the aggregator consumed feed the counterfactual.
  recap.estimatedCacheSavingsUsd = pricingSource
    ? estimateCacheSavingsUsd(pricedEvents, pricingSource, pricingResult.pricingPolicy)
    : undefined;
  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    warnings: dataset.warnings,
    notes: withPricingNotes(dataset.notes, pricedEvents, pricingResult),
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  return {
    recap,
    diagnostics,
  };
}
