import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import { getPeriodKey, type ReportGranularity } from '../utils/time-buckets.js';
import { normalizeProviderFilter } from './build-usage-data-inputs.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  collectCanonicalProviderRoots,
  inferCanonicalProviderRootsFromModels,
  matchesCanonicalProviderFilter,
} from '@ayagmar/agent-sessions/internal';
import {
  applyPricingToUsageEventDataset,
  withPricingNotes,
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
} from '../optimize/aggregate-counterfactual.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import { parseTopRowsOption, resolveTopRowLimit } from './top-option.js';

export type BuildOptimizeDataDeps = BuildUsageDataDeps;

function resolveOptimizeProvider(
  providers: Set<string>,
  providerFilter: string | undefined,
  candidateModels: string[],
  canScopeTo: (provider: string) => boolean,
): { provider: string; inferredFromCandidates: boolean } {
  const distinctProviders = collectCanonicalProviderRoots(providers);
  const normalizedProviderFilter = normalizeProviderFilter(providerFilter);

  if (distinctProviders.length > 1) {
    if (normalizedProviderFilter) {
      const matchingProviders = distinctProviders.filter((provider) =>
        matchesCanonicalProviderFilter(provider, normalizedProviderFilter),
      );

      if (matchingProviders.length === 1) {
        return { provider: matchingProviders[0], inferredFromCandidates: false };
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

    // With no --provider, the candidates' provider scopes the run when, as a --provider
    // value (a substring match), it selects exactly one of the detected providers.
    if (
      candidateProviders?.length === 1 &&
      distinctProviders.includes(candidateProviders[0]) &&
      distinctProviders.filter((provider) =>
        matchesCanonicalProviderFilter(provider, candidateProviders[0]),
      ).length === 1 &&
      canScopeTo(candidateProviders[0])
    ) {
      return { provider: candidateProviders[0], inferredFromCandidates: true };
    }

    throw new Error(
      `Optimize requires a single provider; found providers: ${distinctProviders.join(', ')}. Narrow with --provider.`,
    );
  }

  const provider =
    distinctProviders.length === 1 ? distinctProviders[0] : (normalizedProviderFilter ?? 'unknown');

  return { provider, inferredFromCandidates: false };
}

export async function buildOptimizeData(
  granularity: ReportGranularity,
  options: OptimizeCommandOptions,
  deps: BuildOptimizeDataDeps = {},
): Promise<OptimizeDataResult> {
  const candidateModels = normalizeCandidateModels(options.candidateModel);
  // The candidates are the ones asked for, so all are shown unless --top N picks the cheapest.
  const top = resolveTopRowLimit(parseTopRowsOption(options.top), true);

  const unscopedDataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'optimize.dataset.total',
    () => buildUsageEventDataset(options, deps),
  );
  const detectedProviders = new Set(
    unscopedDataset.filteredEvents
      .map((event) => normalizeProviderFilter(event.provider))
      .filter((provider): provider is string => provider !== undefined),
  );
  const { provider, inferredFromCandidates } = measureRuntimeProfileStageSync(
    deps.runtimeProfile,
    'optimize.resolve_provider',
    () =>
      resolveOptimizeProvider(
        detectedProviders,
        unscopedDataset.normalizedInputs.providerFilter,
        candidateModels,
        // A source named with --source that only has another provider would fail the
        // scoped run, which the user did not ask for.
        (candidateProvider) =>
          unscopedDataset.adaptersToParse.every((adapter) => {
            const fixedProviderRoots = adapter.capabilities?.fixedProviderRoots;

            return (
              !unscopedDataset.normalizedInputs.explicitSourceIds.has(adapter.id.toLowerCase()) ||
              !fixedProviderRoots ||
              fixedProviderRoots.length === 0 ||
              fixedProviderRoots.includes(candidateProvider)
            );
          }),
      ),
  );

  // Rebuilt as if --provider had been passed, so --model rules, filter warnings and the
  // pricing load resolve over that provider's usage alone. The first build already
  // refreshed other machines.
  const dataset = inferredFromCandidates
    ? await measureRuntimeProfileStage(deps.runtimeProfile, 'optimize.dataset.scoped', () =>
        buildUsageEventDataset({ ...options, provider, sync: false }, deps),
      )
    : unscopedDataset;

  // Candidates are priced from period totals at base rates, so the baseline skips
  // per-request tier rates too; otherwise a tier premium would read as savings.
  const pricingResult = await applyPricingToUsageEventDataset(dataset, deps, 'force', {
    perRequestRates: false,
  });
  const { pricedEvents, pricingOrigin, pricingWarning, pricingSource } = pricingResult;

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
    notes: withPricingNotes(dataset.notes, pricedEvents, pricingResult),
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
      ...(inferredFromCandidates ? { inferredProvider: provider } : {}),
      baselineCostIncomplete: counterfactual.baselineCostIncomplete,
      candidatesWithMissingPricing: counterfactual.candidatesWithMissingPricing,
      warning: counterfactual.warning,
    },
  };
}
