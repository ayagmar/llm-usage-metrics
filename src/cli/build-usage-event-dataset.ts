import { getActiveEnvVarOverrides } from '../config/env-var-display.js';
import {
  getParsingRuntimeConfig,
  getPricingFetcherRuntimeConfig,
} from '../config/runtime-overrides.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { createDefaultAdapters } from '../sources/create-default-adapters.js';
import {
  normalizeBuildUsageInputs,
  selectAdaptersForParsing,
  throwOnExplicitSourceScopeConflicts,
} from './build-usage-data-inputs.js';
import {
  filterParsedAdapterEvents,
  parseSelectedAdapters,
  throwOnExplicitSourceFailures,
  type AdapterParseResult,
} from './build-usage-data-parsing.js';
import {
  resolveAndApplyPricingToEvents,
  resolvePricingSource,
  type PricingLoadMode,
} from './build-usage-data-pricing.js';
import type {
  BuildUsageDataDeps,
  ReportCommandOptions,
  UsagePricingOrigin,
  UsageSourceFailure,
} from './usage-data-contracts.js';
import type { SourceAdapter } from '../sources/source-adapter.js';
import type { EnvVarOverride } from '../config/env-var-display.js';
import type { PricingSource } from '../pricing/types.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';

function withNormalizedPricingUrl(
  options: ReportCommandOptions,
  normalizedPricingUrl: string | undefined,
): ReportCommandOptions {
  if (options.pricingUrl === normalizedPricingUrl) {
    return options;
  }

  return {
    ...options,
    pricingUrl: normalizedPricingUrl,
  };
}

export type UsageEventDataset = {
  options: ReportCommandOptions;
  normalizedInputs: ReturnType<typeof normalizeBuildUsageInputs>;
  adaptersToParse: SourceAdapter[];
  successfulParseResults: AdapterParseResult[];
  sourceFailures: UsageSourceFailure[];
  filteredEvents: UsageEvent[];
  pricingRuntimeConfig: ReturnType<typeof getPricingFetcherRuntimeConfig>;
  readEnvVarOverrides: () => EnvVarOverride[];
};

export type UsageEventDatasetPricingResult = {
  pricedEvents: UsageEvent[];
  pricingOrigin: UsagePricingOrigin;
  pricingWarning?: string;
  pricingSource?: PricingSource;
};

export async function buildUsageEventDataset(
  options: ReportCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<UsageEventDataset> {
  const normalizedInputs = normalizeBuildUsageInputs(options);
  const runtimeProfile = deps.runtimeProfile;

  const readParsingRuntimeConfig = deps.getParsingRuntimeConfig ?? getParsingRuntimeConfig;
  const readPricingRuntimeConfig =
    deps.getPricingFetcherRuntimeConfig ?? getPricingFetcherRuntimeConfig;
  const makeAdapters = deps.createAdapters ?? createDefaultAdapters;
  const parsingRuntimeConfig = readParsingRuntimeConfig();
  const pricingRuntimeConfig = readPricingRuntimeConfig();

  const adapters = measureRuntimeProfileStageSync(
    runtimeProfile,
    'usage.dataset.create_adapters',
    () => makeAdapters(options),
  );
  const adaptersToParse = measureRuntimeProfileStageSync(
    runtimeProfile,
    'usage.dataset.select_adapters',
    () =>
      selectAdaptersForParsing(adapters, {
        sourceFilter: normalizedInputs.sourceFilter,
        candidateProviderRoots: normalizedInputs.candidateProviderRoots,
        runtimeProfile,
      }),
  );
  throwOnExplicitSourceScopeConflicts(adapters, adaptersToParse, {
    explicitSourceIds: normalizedInputs.explicitSourceIds,
    candidateProviderRoots: normalizedInputs.candidateProviderRoots,
    providerFilter: normalizedInputs.providerFilter,
    modelFilter: normalizedInputs.modelFilter,
  });

  const { successfulParseResults, sourceFailures } = await measureRuntimeProfileStage(
    runtimeProfile,
    'usage.dataset.parse_adapters',
    () =>
      parseSelectedAdapters(adaptersToParse, parsingRuntimeConfig.maxParallelFileParsing, {
        parseCache: {
          enabled: parsingRuntimeConfig.parseCacheEnabled,
          ttlMs: parsingRuntimeConfig.parseCacheTtlMs,
          maxEntries: parsingRuntimeConfig.parseCacheMaxEntries,
          maxBytes: parsingRuntimeConfig.parseCacheMaxBytes,
        },
        runtimeProfile,
      }),
  );

  throwOnExplicitSourceFailures(sourceFailures, normalizedInputs.explicitSourceIds);

  const filteredEvents = measureRuntimeProfileStageSync(
    runtimeProfile,
    'usage.dataset.filter_events',
    () =>
      filterParsedAdapterEvents(successfulParseResults, {
        timezone: normalizedInputs.timezone,
        since: options.since,
        until: options.until,
        providerFilter: normalizedInputs.providerFilter,
        modelFilter: normalizedInputs.modelFilter,
      }),
  );

  return {
    options,
    normalizedInputs,
    adaptersToParse,
    successfulParseResults,
    sourceFailures,
    filteredEvents,
    pricingRuntimeConfig,
    readEnvVarOverrides: deps.getActiveEnvVarOverrides ?? getActiveEnvVarOverrides,
  };
}

export async function applyPricingToUsageEventDataset(
  dataset: UsageEventDataset,
  deps: BuildUsageDataDeps = {},
  pricingLoadMode: PricingLoadMode = 'auto',
): Promise<UsageEventDatasetPricingResult> {
  const loadPricingSource = deps.resolvePricingSource ?? resolvePricingSource;
  const pricingOptions = withNormalizedPricingUrl(
    dataset.options,
    dataset.normalizedInputs.pricingUrl,
  );

  return measureRuntimeProfileStage(deps.runtimeProfile, 'usage.pricing.apply', () =>
    resolveAndApplyPricingToEvents(
      dataset.filteredEvents,
      pricingOptions,
      dataset.pricingRuntimeConfig,
      loadPricingSource,
      pricingLoadMode,
    ),
  );
}
