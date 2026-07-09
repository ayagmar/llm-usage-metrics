import { getActiveEnvVarOverrides } from '../config/env-var-display.js';
import type { ActiveConfig } from '../config/active-config-display.js';
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
  collectRuntimeConfigEntries,
  mergeActiveConfigEntries,
  resolveUserConfigForOptions,
} from './apply-user-config.js';
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

export type UsageEventDataset = {
  options: ReportCommandOptions;
  normalizedInputs: ReturnType<typeof normalizeBuildUsageInputs>;
  activeConfig?: ActiveConfig;
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
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options;
  const normalizedInputs = normalizeBuildUsageInputs(configuredOptions);
  const runtimeProfile = deps.runtimeProfile;

  const readParsingRuntimeConfig = deps.getParsingRuntimeConfig ?? getParsingRuntimeConfig;
  const readPricingRuntimeConfig =
    deps.getPricingFetcherRuntimeConfig ?? getPricingFetcherRuntimeConfig;
  const readEventStoreRuntimeConfig = deps.getEventStoreRuntimeConfig ?? getEventStoreRuntimeConfig;
  const makeAdapters = deps.createAdapters ?? createDefaultAdapters;
  const config = userConfigResolution.loadedConfig.config;
  const parsingRuntimeConfig = readParsingRuntimeConfig(process.env, config);
  const pricingRuntimeConfig = readPricingRuntimeConfig(process.env, config);
  const eventStoreRuntimeConfig = readEventStoreRuntimeConfig(process.env, config);
  const activeConfig = mergeActiveConfigEntries(userConfigResolution.loadedConfig, [
    ...(userConfigResolution.activeConfig?.entries ?? []),
    ...collectRuntimeConfigEntries(userConfigResolution.loadedConfig),
  ]);

  if (configuredOptions.history && !eventStoreRuntimeConfig.enabled) {
    throw new Error('--history requires the event store (unset LLM_USAGE_EVENT_STORE=0)');
  }

  const adapters = measureRuntimeProfileStageSync(
    runtimeProfile,
    'usage.dataset.create_adapters',
    () => makeAdapters(configuredOptions),
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

  let openedEventStore: EventStore | undefined;
  let dataset: UsageEventDataset | undefined;

  try {
    let eventStoreOpenWarning: string | undefined;
    const {
      successfulParseResults,
      discoveredFiles,
      eventStoreAvailable,
      sourceFailures,
      warnings,
    } = await measureRuntimeProfileStage(
      runtimeProfile,
      'usage.dataset.parse_adapters',
      async () => {
        let parseEventStoreRuntimeConfig = eventStoreRuntimeConfig;

        if (eventStoreRuntimeConfig.enabled) {
          try {
            const openStore = deps.openEventStore ?? openEventStore;
            openedEventStore = await openStore(eventStoreRuntimeConfig.path);
          } catch (error) {
            eventStoreOpenWarning = `Event store disabled after failure: ${getErrorReason(error)}`;
            parseEventStoreRuntimeConfig = { ...eventStoreRuntimeConfig, enabled: false };
          }
        }

        return parseSelectedAdapters(adaptersToParse, parsingRuntimeConfig.maxParallelFileParsing, {
          eventStore: parseEventStoreRuntimeConfig,
          openedStore: openedEventStore,
          parseWorkers: {
            workerCount: parsingRuntimeConfig.parseWorkers,
            minBytes: parsingRuntimeConfig.parseWorkerMinBytes,
          },
          runtimeProfile,
        });
      },
    );
    const parseWarnings = eventStoreOpenWarning ? [eventStoreOpenWarning, ...warnings] : warnings;

    throwOnExplicitSourceFailures(sourceFailures, normalizedInputs.explicitSourceIds);

    let parseResultsForFiltering = successfulParseResults;
    const historyWarnings: string[] = [];

    const historyStore = openedEventStore;

    if (configuredOptions.history && eventStoreAvailable && historyStore) {
      const loadHistoryEvents = deps.loadHistoryEvents ?? loadDefaultHistoryEvents;

      try {
        const historyResult = await measureRuntimeProfileStage(
          runtimeProfile,
          'usage.dataset.history',
          async () =>
            loadHistoryEvents(historyStore, {
              // Only successfully parsed sources: a failed source has an empty
              // discovered set, so all its stored files would look departed.
              selectedSources: successfulParseResults.map((result) => result.source),
              discoveredFiles,
            }),
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
          since: configuredOptions.since,
          until: configuredOptions.until,
          providerFilter: normalizedInputs.providerFilter,
          modelFilter: normalizedInputs.modelFilter,
        }),
    );

    dataset = {
      options: configuredOptions,
      normalizedInputs,
      activeConfig,
      adaptersToParse,
      successfulParseResults: parseResultsForFiltering,
      sourceFailures,
      warnings: [
        ...userConfigResolution.loadedConfig.warnings,
        ...parseWarnings,
        ...historyWarnings,
      ],
      filteredEvents,
      pricingRuntimeConfig,
      readEnvVarOverrides: deps.getActiveEnvVarOverrides ?? getActiveEnvVarOverrides,
    };

    return dataset;
  } finally {
    if (openedEventStore) {
      try {
        const closeStore = deps.closeEventStore ?? closeEventStore;
        closeStore(openedEventStore);
      } catch (error) {
        dataset?.warnings.push(`Event store disabled after failure: ${getErrorReason(error)}`);
      }
    }
  }
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
