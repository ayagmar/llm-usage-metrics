import { getActiveEnvVarOverrides } from '../config/env-var-display.js';
import {
  getEventStoreRuntimeConfig,
  getParsingRuntimeConfig,
  getPricingFetcherRuntimeConfig,
} from '../config/runtime-overrides.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { closeEventStore, openEventStore, type EventStore } from '../persistence/event-store.js';
import {
  loadHistoryEvents as loadDefaultHistoryEvents,
  type EventStoreHistoryResult,
} from '../persistence/event-store-history.js';
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

function getErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatHistoryWarning(historyResult: EventStoreHistoryResult): string {
  return [
    `History: included ${historyResult.servedEventCount} event(s)`,
    `from ${historyResult.servedFileCount} departed file(s)`,
    `(${historyResult.suppressedFileCount} suppressed as moved or duplicated).`,
  ].join(' ');
}

function appendHistoryEvents(
  parseResults: AdapterParseResult[],
  historyEvents: UsageEvent[],
): AdapterParseResult[] {
  if (historyEvents.length === 0) {
    return parseResults;
  }

  const eventsBySource = new Map<string, UsageEvent[]>();

  for (const event of historyEvents) {
    const sourceEvents = eventsBySource.get(event.source) ?? [];
    sourceEvents.push(event);
    eventsBySource.set(event.source, sourceEvents);
  }

  return parseResults.map((parseResult) => {
    const sourceHistoryEvents = eventsBySource.get(parseResult.source);

    if (!sourceHistoryEvents) {
      return parseResult;
    }

    return {
      ...parseResult,
      events: [...parseResult.events, ...sourceHistoryEvents],
    };
  });
}

async function withEventStore<T>(
  filePath: string,
  task: (store: EventStore) => T | Promise<T>,
): Promise<T> {
  const store = await openEventStore(filePath);

  try {
    return await task(store);
  } finally {
    closeEventStore(store);
  }
}

export type UsageEventDataset = {
  options: ReportCommandOptions;
  normalizedInputs: ReturnType<typeof normalizeBuildUsageInputs>;
  adaptersToParse: SourceAdapter[];
  successfulParseResults: AdapterParseResult[];
  sourceFailures: UsageSourceFailure[];
  warnings: string[];
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
  const readEventStoreRuntimeConfig = deps.getEventStoreRuntimeConfig ?? getEventStoreRuntimeConfig;
  const makeAdapters = deps.createAdapters ?? createDefaultAdapters;
  const parsingRuntimeConfig = readParsingRuntimeConfig();
  const pricingRuntimeConfig = readPricingRuntimeConfig();
  const eventStoreRuntimeConfig = readEventStoreRuntimeConfig();

  if (options.history && !eventStoreRuntimeConfig.enabled) {
    throw new Error('--history requires the event store (unset LLM_USAGE_EVENT_STORE=0)');
  }

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

  const { successfulParseResults, discoveredFiles, eventStoreAvailable, sourceFailures, warnings } =
    await measureRuntimeProfileStage(runtimeProfile, 'usage.dataset.parse_adapters', () =>
      parseSelectedAdapters(adaptersToParse, parsingRuntimeConfig.maxParallelFileParsing, {
        eventStore: eventStoreRuntimeConfig,
        runtimeProfile,
      }),
    );

  throwOnExplicitSourceFailures(sourceFailures, normalizedInputs.explicitSourceIds);

  let parseResultsForFiltering = successfulParseResults;
  const historyWarnings: string[] = [];

  if (options.history && eventStoreAvailable) {
    const loadHistoryEvents = deps.loadHistoryEvents ?? loadDefaultHistoryEvents;

    try {
      const historyResult = await measureRuntimeProfileStage(
        runtimeProfile,
        'usage.dataset.history',
        () =>
          withEventStore(eventStoreRuntimeConfig.path, (store) =>
            loadHistoryEvents(store, {
              selectedSources: adaptersToParse.map((adapter) => adapter.id),
              discoveredFiles,
            }),
          ),
      );
      parseResultsForFiltering = appendHistoryEvents(
        parseResultsForFiltering,
        historyResult.events,
      );
      historyWarnings.push(formatHistoryWarning(historyResult));
    } catch (error) {
      historyWarnings.push(`Event store disabled after failure: ${getErrorReason(error)}`);
    }
  }

  const filteredEvents = measureRuntimeProfileStageSync(
    runtimeProfile,
    'usage.dataset.filter_events',
    () =>
      filterParsedAdapterEvents(parseResultsForFiltering, {
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
    successfulParseResults: parseResultsForFiltering,
    sourceFailures,
    warnings: [...warnings, ...historyWarnings],
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
