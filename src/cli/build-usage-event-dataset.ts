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
  type EventStoreHistoryDiscoveredFile,
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
import { loadMachineUsage, selectMachines } from '../machines/load-machine-usage.js';
import { formatMachinesNote, formatRefreshFailure } from '../render/render-machines.js';
import { refreshDueMachines } from '../machines/refresh-machines.js';
import { loadPackageMetadataFromRuntime } from './package-metadata.js';
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

/** Adds other machines' events to the per-source results, creating any source missing here. */
function appendMachineEvents(
  parseResults: AdapterParseResult[],
  machineEvents: UsageEvent[],
): AdapterParseResult[] {
  const results = parseResults.map((result) => ({ ...result, events: [...result.events] }));
  const resultsBySource = new Map(results.map((result) => [result.source, result]));

  for (const event of machineEvents) {
    let result = resultsBySource.get(event.source);

    if (!result) {
      result = {
        source: event.source,
        events: [],
        filesFound: 0,
        skippedRows: 0,
        skippedRowReasons: [],
      };
      resultsBySource.set(event.source, result);
      results.push(result);
    }

    result.events.push(event);
  }

  return results;
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
  /**
   * The event store and the stored files whose events this run counts: parsed files and
   * the departed files history served. Undefined when the event store was unavailable.
   */
  ledger?: {
    path: string;
    parsedFiles: EventStoreHistoryDiscoveredFile[];
    historyFiles: EventStoreHistoryDiscoveredFile[];
  };
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
  // Before parsing, so a mistyped --machine fails fast.
  const machineSelection = selectMachines(config.machines, normalizedInputs.machineFilter, {
    customSourceDirectories: cliDirectorySourceIds.size > 0,
  });
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

  const nowMs = () => (deps.now?.() ?? new Date()).getTime();
  // Refreshing other machines runs alongside the local parse; a failed run stops it.
  const machineRefreshAbort = new AbortController();
  const machineRefresh =
    configuredOptions.sync === false
      ? Promise.resolve([])
      : refreshDueMachines(
          Object.entries(config.machines ?? {})
            .filter(([name]) => machineSelection.names.includes(name))
            .map(([name, machine]) => ({ name, machine })),
          { now: nowMs, spawnSsh: deps.spawnSsh, signal: machineRefreshAbort.signal },
        );
  const includeHistory = configuredOptions.history !== false;

  let openedEventStore: EventStore | undefined;
  let dataset: UsageEventDataset | undefined;

  try {
    let eventStoreOpenWarning: string | undefined;
    const {
      successfulParseResults,
      discoveredFiles,
      parsedFiles,
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
    // A discovered file that failed to parse is not counted, though history still treats it
    // as present.
    const ledger: UsageEventDataset['ledger'] = eventStoreAvailable
      ? { path: eventStoreRuntimeConfig.path, parsedFiles: [...parsedFiles], historyFiles: [] }
      : undefined;
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
        ledger?.historyFiles.push(...historyResult.servedFiles);
        // Default history stays quiet unless it changes the numbers.
        if (historyRequested || historyResult.servedFileCount > 0) {
          historyNotes.push(formatHistoryNote(historyResult));
        }
      } catch (error) {
        historyWarnings.push(`Event store disabled after failure: ${getErrorReason(error)}`);
      }
    }

    const machineWarnings: string[] = [];
    const machineNotes: string[] = [];

    if (!machineSelection.includeLocal) {
      parseResultsForFiltering = parseResultsForFiltering.map((result) => ({
        ...result,
        events: [],
      }));
    }

    const refreshOutcomes = await measureRuntimeProfileStage(
      runtimeProfile,
      'usage.dataset.machine_refresh',
      () => machineRefresh,
    );

    for (const outcome of refreshOutcomes) {
      if (outcome.ok) {
        machineWarnings.push(
          ...outcome.remoteWarnings.map((warning) => `${outcome.name} warned: ${warning}`),
        );
        continue;
      }

      const failure = formatRefreshFailure(outcome, nowMs());

      if (failure) {
        (failure.stale ? machineWarnings : machineNotes).push(failure.text);
      }
    }

    if (machineSelection.names.length > 0) {
      const machineUsage = await measureRuntimeProfileStage(
        runtimeProfile,
        'usage.dataset.machines',
        () =>
          loadMachineUsage({
            names: machineSelection.names,
            disabledNames: new Set(
              machineSelection.names.filter((name) => config.machines?.[name]?.enabled === false),
            ),
            servedEvents: parseResultsForFiltering.flatMap((result) => result.events),
            sources: new Set(adaptersToParse.map((adapter) => adapter.id)),
            since: configuredOptions.since,
            until: configuredOptions.until,
          }),
      );
      parseResultsForFiltering = appendMachineEvents(parseResultsForFiltering, machineUsage.events);
      machineWarnings.push(...machineUsage.warnings);
      machineNotes.push(
        formatMachinesNote(
          machineUsage.machines,
          nowMs(),
          loadPackageMetadataFromRuntime().packageVersion,
        ),
      );
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
        ...machineWarnings,
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
      notes: [...historyNotes, ...machineNotes],
      filteredEvents,
      ledger,
      pricingRuntimeConfig,
      readEnvVarOverrides: deps.getActiveEnvVarOverrides ?? getActiveEnvVarOverrides,
    };

    return dataset;
  } finally {
    // Settled already on success; stops a refresh the failed run no longer needs.
    machineRefreshAbort.abort();

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
