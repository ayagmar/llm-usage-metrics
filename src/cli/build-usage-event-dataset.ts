import { getActiveEnvVarOverrides } from '../config/env-var-display.js';
import type { ActiveConfig } from '../config/active-config-display.js';
import {
  getEventStoreRuntimeConfig,
  getParsingRuntimeConfig,
  getPricingFetcherRuntimeConfig,
} from '../config/runtime-overrides.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { limitNamedModels } from '../render/format-model-list.js';
import {
  closeEventStore,
  openEventStore,
  readOverrideOnlyFiles,
  type EventStore,
} from '../persistence/event-store.js';
import { addStoredFilesStillOnDisk } from './history-live-files.js';
import {
  loadHistoryEvents as loadDefaultHistoryEvents,
  type EventStoreHistoryDiscoveredFile,
  type EventStoreHistoryResult,
} from '../persistence/event-store-history.js';
import { createAdaptersFromOptions } from './source-cli-options.js';
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
import {
  formatMachinesNote,
  formatRefreshFailure,
  formatStoredSyncFailure,
} from '../render/render-machines.js';
import { refreshDueMachines } from '../machines/refresh-machines.js';
import { loadPackageMetadataFromRuntime } from './package-metadata.js';
import {
  resolveAndApplyPricingToEvents,
  resolvePricingSource,
  type PricedEventsResult,
  type PricingLoadMode,
} from './build-usage-data-pricing.js';
import type { PricingCostMode } from '../pricing/cost-engine.js';
import type {
  BuildUsageDataDeps,
  ReportCommandOptions,
  UsageSourceFailure,
} from './usage-data-contracts.js';
import { dedupeCopiedSessions, type SourceAdapter } from '@ayagmar/agent-sessions';
import {
  getRepeatingSourceIds,
  getSessionCopyingSourceIds,
} from '@ayagmar/agent-sessions/internal';
import type { EnvVarOverride } from '../config/env-var-display.js';
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
    /** Events those files hold that the run counted once, as copies of another session's. */
    copiedEventCount: number;
  };
  pricingRuntimeConfig: ReturnType<typeof getPricingFetcherRuntimeConfig>;
  readEnvVarOverrides: () => EnvVarOverride[];
};

export type UsageEventDatasetPricingResult = PricedEventsResult;

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
  const makeAdapters = deps.createAdapters ?? createAdaptersFromOptions;
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
      failedFiles,
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
          overrideSourceIds: cliDirectorySourceIds,
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
    const ledger: UsageEventDataset['ledger'] = eventStoreAvailable
      ? {
          path: eventStoreRuntimeConfig.path,
          parsedFiles: [...parsedFiles],
          historyFiles: [],
          copiedEventCount: 0,
        }
      : undefined;
    const historyWarnings: string[] = [];
    const historyNotes: string[] = [];

    const historyStore = openedEventStore;
    const failedFileKeys = new Set(failedFiles.map((file) => `${file.source}\0${file.filePath}`));

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
                  // A file that failed to parse has not departed, but this run does not
                  // count its stored events, so they cannot suppress a departed copy.
                  discoveredFiles: discoveredFiles.filter(
                    (file) => !failedFileKeys.has(`${file.source}\0${file.filePath}`),
                  ),
                  // Files only ever found under a custom directory never departed from
                  // their source's usual location, so a run there leaves them out.
                  presentFiles: [
                    ...failedFiles,
                    ...readOverrideOnlyFiles(historyStore).filter(
                      (file) => !cliDirectorySourceIds.has(file.source),
                    ),
                  ],
                  repeatingSources: getRepeatingSourceIds(adaptersToParse),
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

      // A refresh that ran this time already said how it went.
      const refreshedNames = new Set(refreshOutcomes.map((outcome) => outcome.name));

      for (const machine of machineUsage.machines) {
        const failure = refreshedNames.has(machine.name)
          ? undefined
          : formatStoredSyncFailure(machine, nowMs());

        if (failure) {
          (failure.stale ? machineWarnings : machineNotes).push(failure.text);
        }
      }
      machineNotes.push(
        formatMachinesNote(
          machineUsage.machines,
          nowMs(),
          loadPackageMetadataFromRuntime().packageVersion,
        ),
      );
    }

    // After history and other machines, so a departed or remote copy is counted once too.
    const sessionCopyingSources = getSessionCopyingSourceIds(adaptersToParse);
    parseResultsForFiltering = measureRuntimeProfileStageSync(
      runtimeProfile,
      'usage.dataset.count_copies',
      () =>
        parseResultsForFiltering.map((result) => {
          if (!sessionCopyingSources.has(result.source)) {
            return result;
          }

          const events = dedupeCopiedSessions(result.events);

          if (ledger) {
            ledger.copiedEventCount += result.events.length - events.length;
          }

          return { ...result, events };
        }),
    );

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
    resolveAndApplyPricingToEvents(dataset.filteredEvents, pricingOptions, {
      runtimeConfig: dataset.pricingRuntimeConfig,
      loadPricingSource,
      pricingLoadMode,
    }),
  );
}

const MAX_NAMED_UNPRICED_MODELS = 5;

function formatEventCount(count: number): string {
  const eventLabel = count === 1 ? 'event' : 'events';
  return `${new Intl.NumberFormat('en-US').format(count)} ${eventLabel}`;
}

/**
 * Reports leave an event without a cost out of cost totals and mark those totals with `~`.
 * Returns the note explaining that marker for the events a report shows, if any lack a cost.
 */
function describeUnpricedEvents(
  events: readonly UsageEvent[],
  costMode: PricingCostMode,
): string | undefined {
  const unpricedEvents = events.filter((event) => event.costUsd === undefined);

  if (unpricedEvents.length === 0) {
    return undefined;
  }

  const eventCount = formatEventCount(unpricedEvents.length);

  if (costMode === 'explicit') {
    return `~ marks costs that leave out ${eventCount} with no logged cost (--cost-mode explicit)`;
  }

  const models = [...new Set(unpricedEvents.map((event) => event.model ?? 'unknown'))].sort();
  const modelList = limitNamedModels(models, MAX_NAMED_UNPRICED_MODELS).join(', ');

  return `~ marks costs that leave out ${eventCount} with no known price (models: ${modelList})`;
}

/**
 * A source can log $0 for a request that used tokens; `both` estimates those events instead.
 * Returns the note naming those sources, unless the user chose a cost mode.
 */
function describeReestimatedExplicitZero(
  events: readonly UsageEvent[],
  pricingResult: PricingNotesInput,
): string | undefined {
  if (pricingResult.costModeOption !== undefined) {
    return undefined;
  }

  const reestimated = pricingResult.pricingStats.reestimatedExplicitZero;
  const reestimatedEvents = events.filter((event) => reestimated.has(event));

  if (reestimatedEvents.length === 0) {
    return undefined;
  }

  const sources = [...new Set(reestimatedEvents.map((event) => event.source))].sort().join(', ');
  const verb = reestimatedEvents.length === 1 ? 'was' : 'were';

  return `${formatEventCount(reestimatedEvents.length)} logged $0 by ${sources} ${verb} estimated from LiteLLM; use --cost-mode explicit to keep $0`;
}

type PricingNotesInput = Pick<
  UsageEventDatasetPricingResult,
  'pricingPolicy' | 'pricingStats' | 'costModeOption'
>;

/**
 * The dataset's notes plus the pricing notes for the events a report shows. Notes count only
 * `shownEvents`, which must be the priced events themselves (the stats are keyed by identity);
 * `pricingResult` gives the policy and stats of the run that priced them.
 */
export function withPricingNotes(
  notes: readonly string[],
  shownEvents: readonly UsageEvent[],
  pricingResult: PricingNotesInput,
): string[] {
  const pricingNotes = [
    describeUnpricedEvents(shownEvents, pricingResult.pricingPolicy.costMode),
    describeReestimatedExplicitZero(shownEvents, pricingResult),
  ].filter((note) => note !== undefined);

  return [...notes, ...pricingNotes];
}
