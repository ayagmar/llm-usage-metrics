import { getActiveEnvVarOverrides } from '../config/env-var-display.js';
import type { ActiveConfig } from '../config/active-config-display.js';
import {
  getEventStoreRuntimeConfig,
  getParsingRuntimeConfig,
  getPricingFetcherRuntimeConfig,
} from '../config/runtime-overrides.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { closeEventStore, openEventStore, type EventStore } from '../persistence/event-store.js';
import { addStoredFilesStillOnDisk } from './history-live-files.js';
import {
  loadHistoryEvents as loadDefaultHistoryEvents,
  type EventStoreHistoryResult,
} from '../persistence/event-store-history.js';
import { createDefaultAdapters } from '../sources/create-default-adapters.js';
import {
  normalizeBuildUsageInputs,
  resolveCliDirectorySourceIds,
  selectAdaptersForParsing,
  throwOnExplicitSourceScopeConflicts,
} from './build-usage-data-inputs.js';
import {
  collectRuntimeConfigEntries,
  mergeActiveConfigEntries,
  resolveUserConfigForOptions,
} from './apply-user-config.js';
import {
  parseSelectedAdapters,
  throwOnExplicitSourceFailures,
  type AdapterParseResult,
} from './build-usage-data-parsing.js';
import { filterParsedAdapterEvents } from './parse/usage-event-filters.js';
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
import { findUnmatchedFilterWarnings } from './filter-match-warnings.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import { getErrorReason } from '../utils/get-error-reason.js';

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

function formatHistoryNote(historyResult: EventStoreHistoryResult): string {
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
  notes: string[];
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
  const normalizedInputs = normalizeBuildUsageInputs(
    configuredOptions,
    userConfigResolution.cliOptions,
  );
  const runtimeProfile = deps.runtimeProfile;

  const readParsingRuntimeConfig = deps.getParsingRuntimeConfig ?? getParsingRuntimeConfig;
  const readPricingRuntimeConfig =
    deps.getPricingFetcherRuntimeConfig ?? getPricingFetcherRuntimeConfig;
  const readEventStoreRuntimeConfig = deps.getEventStoreRuntimeConfig ?? getEventStoreRuntimeConfig;
  const makeAdapters = deps.createAdapters ?? createDefaultAdapters;
  const config = userConfigResolution.loadedConfig.config;
  const parsingRuntimeConfig = readParsingRuntimeConfig(process.env, config);
  const pricingRuntimeConfig = readPricingRuntimeConfig(config);
  const eventStoreRuntimeConfig = readEventStoreRuntimeConfig(process.env, config);
  const activeConfig = mergeActiveConfigEntries(userConfigResolution.loadedConfig, [
    ...(userConfigResolution.activeConfig?.entries ?? []),
    ...collectRuntimeConfigEntries(userConfigResolution.loadedConfig),
  ]);

  // History is on by default; only an explicit --history fails when it cannot be honored.
  const historyRequested = configuredOptions.history === true;
  const cliDirectorySourceIds = resolveCliDirectorySourceIds(userConfigResolution.cliOptions);
  const includeHistory = configuredOptions.history !== false;

  if (historyRequested && !eventStoreRuntimeConfig.enabled) {
    throw new Error(
      eventStoreRuntimeConfig.disabledBy === 'environment'
        ? '--history requires the event store (unset LLM_USAGE_EVENT_STORE=0)'
        : '--history requires the event store (set eventStore.enabled = true in config.toml)',
    );
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
        sourceFilterLabel: normalizedInputs.sourceFilterLabel,
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
            if (historyRequested) {
              throw new Error(
                `--history could not open the event store at ${eventStoreRuntimeConfig.path}: ${getErrorReason(error)}`,
                { cause: error },
              );
            }

            eventStoreOpenWarning = `Event store disabled after failure: ${getErrorReason(error)}`;
            parseEventStoreRuntimeConfig = {
              enabled: false,
              path: eventStoreRuntimeConfig.path,
              disabledBy: 'configuration',
            };
          }
        }

        return parseSelectedAdapters(adaptersToParse, parsingRuntimeConfig.maxParallelFileParsing, {
          eventStore: parseEventStoreRuntimeConfig,
          openedStore: openedEventStore,
          since: configuredOptions.since,
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
    const historyNotes: string[] = [];

    const historyStore = openedEventStore;

    // By default, a source pointed at a custom directory (e.g. an export) gets no history:
    // departed files from its usual location would leak into a report scoped elsewhere.
    const historySources = successfulParseResults
      .map((result) => result.source)
      .filter((source) => historyRequested || !cliDirectorySourceIds.has(source.toLowerCase()));

    if (includeHistory && eventStoreAvailable && historyStore && historySources.length > 0) {
      const loadHistoryEvents = deps.loadHistoryEvents ?? loadDefaultHistoryEvents;

      try {
        const historyResult = await measureRuntimeProfileStage(
          runtimeProfile,
          'usage.dataset.history',
          async () =>
            loadHistoryEvents(
              historyStore,
              await addStoredFilesStillOnDisk(
                historyStore,
                {
                  // Only successfully parsed sources: a failed source has an empty
                  // discovered set, so all its stored files would look departed.
                  selectedSources: historySources,
                  discoveredFiles,
                },
                { unverifiable: 'treat-as-departed' },
              ),
            ),
        );
        parseResultsForFiltering = appendHistoryEvents(
          parseResultsForFiltering,
          historyResult.events,
        );
        // Default history stays quiet unless it changes the numbers.
        if (historyRequested || historyResult.servedFileCount > 0) {
          historyNotes.push(formatHistoryNote(historyResult));
        }
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
        ...findUnmatchedFilterWarnings({
          parseResults: parseResultsForFiltering,
          // A `sources` list from config.toml is a standing default, not a typed filter.
          cliSourceFilter: userConfigResolution.activeConfig?.entries.some(
            (entry) => entry.key === 'sources',
          )
            ? undefined
            : normalizedInputs.sourceFilter,
          provider: configuredOptions.provider,
          modelFilter: normalizedInputs.modelFilter,
          timezone: normalizedInputs.timezone,
          since: configuredOptions.since,
          until: configuredOptions.until,
        }),
      ],
      notes: historyNotes,
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
