import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import { getPeriodKey, type ReportGranularity } from '../utils/time-buckets.js';
import { normalizeProviderFilter } from './build-usage-data-inputs.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  collectCanonicalProviderRoots,
  inferCanonicalProviderRootsFromModels,
  matchesCanonicalProviderFilter,
} from '../domain/provider-normalization.js';
import {
  applyPricingToUsageEventDataset,
  withUnpricedEventsNote,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import type {
  BuildUsageDataDeps,
  OptimizeCommandOptions,
  OptimizeDataResult,
} from './usage-data-contracts.js';
import {
  buildCounterfactualRows,
  normalizeCandidateModels,
  parseTopOption,
} from '../optimize/aggregate-counterfactual.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';

export type BuildOptimizeDataDeps = BuildUsageDataDeps;

function resolveOptimizeProvider(
  providers: Set<string>,
  providerFilter: string | undefined,
  candidateModels: string[],
): string {
  const distinctProviders = collectCanonicalProviderRoots(providers);
  const normalizedProviderFilter = normalizeProviderFilter(providerFilter);

  if (distinctProviders.length > 1) {
    if (normalizedProviderFilter) {
      const matchingProviders = distinctProviders.filter((provider) =>
        matchesCanonicalProviderFilter(provider, normalizedProviderFilter),
      );

      if (matchingProviders.length === 1) {
        return matchingProviders[0];
      }

      if (matchingProviders.length === 0) {
        throw new Error(
          `Optimize --provider "${normalizedProviderFilter}" matched no providers. Available providers: ${distinctProviders.join(', ')}.`,
        );
      }

      if (matchingProviders.length > 1) {
        throw new Error(
          `Optimize matched multiple providers for --provider "${normalizedProviderFilter}": ${matchingProviders.join(', ')}. Supply a more specific --provider value.`,
        );
      }
    }

    const candidateProviders = inferCanonicalProviderRootsFromModels(candidateModels);
    // --provider matches by substring, so only suggest a value that selects one provider.
    const suggestedProvider =
      candidateProviders?.length === 1 &&
      distinctProviders.includes(candidateProviders[0]) &&
      distinctProviders.filter((provider) =>
        matchesCanonicalProviderFilter(provider, candidateProviders[0]),
      ).length === 1
        ? ` ${candidateProviders[0]}`
        : '';

    throw new Error(
      `Optimize requires a single provider; found providers: ${distinctProviders.join(', ')}. Narrow with --provider${suggestedProvider}.`,
    );
  }

  if (distinctProviders.length === 1) {
    return distinctProviders[0];
  }

  return normalizedProviderFilter ?? 'unknown';
}

export async function buildOptimizeData(
  granularity: ReportGranularity,
  options: OptimizeCommandOptions,
  deps: BuildOptimizeDataDeps = {},
): Promise<OptimizeDataResult> {
  const candidateModels = normalizeCandidateModels(options.candidateModel);
  const top = parseTopOption(options.top);

  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'optimize.dataset.total',
    () => buildUsageEventDataset(options, deps),
  );
  const detectedProviders = new Set(
    dataset.filteredEvents
      .map((event) => normalizeProviderFilter(event.provider))
      .filter((provider): provider is string => provider !== undefined),
  );
  const provider = measureRuntimeProfileStageSync(
    deps.runtimeProfile,
    'optimize.resolve_provider',
    () =>
      resolveOptimizeProvider(
        detectedProviders,
        dataset.normalizedInputs.providerFilter,
        candidateModels,
      ),
  );

  const { pricedEvents, pricingOrigin, pricingWarning, pricingSource } =
    await applyPricingToUsageEventDataset(dataset, deps, 'force');

  const usageRows = measureRuntimeProfileStageSync(
    deps.runtimeProfile,
    'optimize.aggregate_usage',
    () =>
      aggregateUsage(pricedEvents, {
        granularity,
        timezone: dataset.normalizedInputs.timezone,
        sourceOrder: dataset.adaptersToParse.map((adapter) => adapter.id),
        includeModelBreakdown: false,
      }),
  );

  const oneHourCacheWritesByPeriod = new Map<string, number>();

  for (const event of pricedEvents) {
    if (event.cacheWrite1hTokens === 0) {
      continue;
    }

    const periodKey = getPeriodKey(event.timestamp, granularity, dataset.normalizedInputs.timezone);

    for (const key of [periodKey, 'ALL']) {
      oneHourCacheWritesByPeriod.set(
        key,
        (oneHourCacheWritesByPeriod.get(key) ?? 0) + event.cacheWrite1hTokens,
      );
    }
  }

  const counterfactual = measureRuntimeProfileStageSync(
    deps.runtimeProfile,
    'optimize.counterfactual',
    () =>
      buildCounterfactualRows({
        usageRows,
        oneHourCacheWritesByPeriod,
        provider,
        candidateModels,
        pricingSource,
        top,
      }),
  );

  const usageDiagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    warnings: dataset.warnings,
    notes: withUnpricedEventsNote(dataset.notes, pricedEvents),
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  return {
    rows: counterfactual.rows,
    diagnostics: {
      ...usageDiagnostics,
      provider,
      baselineCostIncomplete: counterfactual.baselineCostIncomplete,
      candidatesWithMissingPricing: counterfactual.candidatesWithMissingPricing,
      warning: counterfactual.warning,
    },
  };
}
