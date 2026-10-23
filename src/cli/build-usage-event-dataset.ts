import { getActiveEnvVarOverrides } from '../config/env-var-display.js';
import type { ActiveConfig } from '../config/active-config-display.js';
import {
  getEventStoreRuntimeConfig,
  getParsingRuntimeConfig,
  getPricingFetcherRuntimeConfig,
} from '../config/runtime-overrides.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { truncateNames } from '../render/truncate-names.js';
import {
  closeEventStore,
  openEventStore,
  readOverrideOnlyFiles,
  readGitRoots,
  recordGitRoots,
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
  normalizeSourceFilter,
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
  type ParsedSourceFile,
} from './build-usage-data-parsing.js';
import { filterParsedAdapterEventsWithLookback } from './parse/usage-event-filters.js';
import { applyRepoFilter, moveRepoFilterPaths, type RepoFilter } from './repo-filter.js';
import {
  loadMachineUsage,
  selectMachines,
  type MachineUsageSummary,
} from '../machines/load-machine-usage.js';
import {
  formatMachinesNote,
  formatRefreshFailure,
  formatStoredSyncFailure,
} from '../render/render-machines.js';
import { refreshDueMachines } from '../machines/refresh-machines.js';
import { loadPackageMetadataFromRuntime } from './package-metadata.js';
import {
  resolveAndApplyPricingToEvents,
  resolvePricingPolicy,
  resolvePricingSource,
  type PricedEventsResult,
  type PricingLoadMode,
} from './build-usage-data-pricing.js';
import type { PricingCostMode } from '@ayagmar/agent-sessions/internal';
import type {
  BuildUsageDataDeps,
  ReportCommandOptions,
  ReportNote,
  UsageSourceFailure,
} from './usage-data-contracts.js';
import { dedupeCopiedSessions, type SourceAdapter } from '@ayagmar/agent-sessions';
import {
  getRepeatingSourceIds,
  getSessionCopyingSourceIds,
  pluralize,
} from '@ayagmar/agent-sessions/internal';
import type { EnvVarOverride } from '../config/env-var-display.js';
import { findUnmatchedFilterWarnings } from './filter-match-warnings.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import { getErrorReason } from '../utils/get-error-reason.js';
import { attributeEventsToSessionRoots } from '../session/aggregate-sessions.js';
import {
  moveEventRepoRoots,
  moveEventsToRepositories,
  resolveWorktreeRoots,
} from '../session/worktree-roots.js';
import { createProjectAliasResolver } from '../session/project-aliases.js';
import {
  collectGitRootRemotes,
  moveMachineEventsToLocalRepositories,
} from '../session/git-remotes.js';
import { toProjectKey } from '../aggregate/project-key.js';

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
    `History: included ${pluralize(historyResult.servedEventCount, 'event')}`,
    `from ${pluralize(historyResult.servedFileCount, 'departed file')}`,
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

/**
 * Moves the usage of git worktrees on this machine to their repositories
 * (`resolveWorktreeRoots`), and the `--repo` paths with it. Reads the git roots earlier runs
 * found from the store and records those this run found; a store failure only loses that
 * record.
 */
function attributeWorktreesToRepositories(
  parseResults: AdapterParseResult[],
  store: EventStore | undefined,
  repoFilter: RepoFilter | undefined,
): {
  parseResults: AdapterParseResult[];
  repoFilter: RepoFilter | undefined;
  warnings: string[];
  /** Every git root known, recorded or found by this run, with its repository's key. */
  roots: Map<string, string>;
} {
  const warnings: string[] = [];
  let storedRoots = new Map<string, string>();

  try {
    storedRoots = store ? readGitRoots(store) : storedRoots;
  } catch (error) {
    warnings.push(`Could not read the git roots in the event store: ${getErrorReason(error)}`);
  }

  // Other machines' paths name nothing on this disk.
  const localRepoRoots = new Set<string | undefined>();

  for (const result of parseResults) {
    for (const event of result.events) {
      if (event.machine === undefined) {
        localRepoRoots.add(event.repoRoot);
      }
    }
  }

  const worktreeRoots = resolveWorktreeRoots(
    [...localRepoRoots].flatMap((repoRoot) => toProjectKey(repoRoot) ?? []),
    storedRoots,
  );

  try {
    if (store) {
      recordGitRoots(store, worktreeRoots.newRoots);
    }
  } catch (error) {
    warnings.push(`Could not record git roots in the event store: ${getErrorReason(error)}`);
  }

  const movedEvents = moveEventsToRepositories(
    parseResults.map((result) => result.events),
    worktreeRoots.repoKeyOf,
  );

  return {
    parseResults: parseResults.map((result, index) => ({
      ...result,
      events: movedEvents[index] ?? result.events,
    })),
    repoFilter: moveRepoFilterPaths(repoFilter, worktreeRoots.repoKeyOf),
    warnings,
    roots: new Map([...storedRoots, ...worktreeRoots.newRoots]),
  };
}

/**
 * Moves other machines' usage to the repository here with the same remote
 * (`moveMachineEventsToLocalRepositories`), for machines whose last sync recorded remotes.
 * Reads this machine's repositories' remotes only when one did.
 */
function attributeMachinesToLocalRepositories(
  parseResults: AdapterParseResult[],
  machines: readonly MachineUsageSummary[] | undefined,
  roots: ReadonlyMap<string, string>,
): AdapterParseResult[] {
  const machineRemotes = new Map(
    (machines ?? []).flatMap((machine) => {
      const remotes = machine.state?.gitRemotes;
      return remotes && Object.keys(remotes).length > 0
        ? [[machine.name, new Map(Object.entries(remotes))] as const]
        : [];
    }),
  );

  if (machineRemotes.size === 0) {
    return parseResults;
  }

  const repositories = new Map([...roots].filter(([root, repoKey]) => root === repoKey));
  const moved = moveMachineEventsToLocalRepositories(
    parseResults.map((result) => result.events),
    collectGitRootRemotes(repositories),
    machineRemotes,
  );

  return parseResults.map((result, index) => ({
    ...result,
    events: moved[index] ?? result.events,
  }));
}

export type UsageEventDataset = {
  options: ReportCommandOptions;
  normalizedInputs: ReturnType<typeof normalizeBuildUsageInputs>;
  activeConfig?: ActiveConfig;
  adaptersToParse: SourceAdapter[];
  successfulParseResults: AdapterParseResult[];
  sourceFailures: UsageSourceFailure[];
  warnings: string[];
  notes: ReportNote[];
  filteredEvents: UsageEvent[];
  /**
   * With `lookbackSince`, the events from that date to the day before `since`, filtered with
   * the rules the window resolved; empty otherwise.
   */
  lookbackEvents: UsageEvent[];
  /**
   * The local files whose events this run counts: discovered, parsed or served from the
   * store, and not skipped as last modified before the window (those the store lacked are
   * parsed and marked `beforeWindow`).
   */
  parsedFiles: ParsedSourceFile[];
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
  /** The other machines whose cached usage this run read; unset when it read none. */
  machines?: MachineUsageSummary[];
  pricingRuntimeConfig: ReturnType<typeof getPricingFetcherRuntimeConfig>;
  readEnvVarOverrides: () => EnvVarOverride[];
};

export type UsageEventDatasetPricingResult = PricedEventsResult;

export async function buildUsageEventDataset(
  options: ReportCommandOptions,
  deps: BuildUsageDataDeps = {},
  request: {
    /** Also read from this date, before `since`, for context (`lookbackEvents`). */
    lookbackSince?: string;
    /**
     * Keep each event's recorded `repoRoot` instead of its session's project
     * (`attributeEventsToSessionRoots`): for `events`, which exports what was logged,
     * `efficiency`, which looks for `.git` from it, and `machine export`, which reads the store.
     */
    recordedRepoRoots?: boolean;
  } = {},
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
  const eventStoreRuntimeConfig = readEventStoreRuntimeConfig(process.env, config);
  const parsingRuntimeConfig = readParsingRuntimeConfig(
    process.env,
    config,
    eventStoreRuntimeConfig.enabled,
  );
  const pricingRuntimeConfig = readPricingRuntimeConfig(config);
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
          since: request.lookbackSince ?? configuredOptions.since,
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
    const historyNotes: ReportNote[] = [];

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
        // An explicit --history reports its totals; default history is detail for --verbose.
        if (historyRequested) {
          historyNotes.push(formatHistoryNote(historyResult));
        } else if (historyResult.servedFileCount > 0) {
          historyNotes.push({ verbose: formatHistoryNote(historyResult) });
        }
      } catch (error) {
        historyWarnings.push(`Event store disabled after failure: ${getErrorReason(error)}`);
      }
    }

    const machineWarnings: string[] = [];
    const machineNotes: ReportNote[] = [];
    let machines: MachineUsageSummary[] | undefined;

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
            adapters: adaptersToParse,
            since: request.lookbackSince ?? configuredOptions.since,
            until: configuredOptions.until,
          }),
      );
      parseResultsForFiltering = appendMachineEvents(parseResultsForFiltering, machineUsage.events);
      machines = machineUsage.machines;
      machineWarnings.push(...machineUsage.warnings);
      machineNotes.push(...machineUsage.notes);

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
      if (machineUsage.machines.length > 0) {
        machineNotes.push({
          verbose: formatMachinesNote(
            machineUsage.machines,
            nowMs(),
            loadPackageMetadataFromRuntime().packageVersion,
          ),
        });
      }
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

    let repoFilter = normalizedInputs.repoFilter;
    const worktreeWarnings: string[] = [];

    // Before the date, model and --repo filters, so a local session's own root does not
    // depend on them. Other machines' events and the other sessions' roots known still
    // depend on what was read (the window, skipped files, --source, --machine).
    if (!request.recordedRepoRoots) {
      const attributedEvents = measureRuntimeProfileStageSync(
        runtimeProfile,
        'usage.dataset.attribute_projects',
        () =>
          attributeEventsToSessionRoots(parseResultsForFiltering.map((result) => result.events)),
      );
      parseResultsForFiltering = parseResultsForFiltering.map((result, index) => ({
        ...result,
        events: attributedEvents[index] ?? result.events,
      }));

      // After the session roots, so a session that moved from its repository into one of
      // its worktrees counts once under the repository.
      const moved = measureRuntimeProfileStageSync(
        runtimeProfile,
        'usage.dataset.attribute_worktrees',
        () =>
          attributeWorktreesToRepositories(
            parseResultsForFiltering,
            eventStoreAvailable ? openedEventStore : undefined,
            repoFilter,
          ),
      );
      parseResultsForFiltering = moved.parseResults;
      repoFilter = moved.repoFilter;
      worktreeWarnings.push(...moved.warnings);

      // After the worktrees, whose roots it reads, and before the aliases, which then apply
      // to the repository here.
      parseResultsForFiltering = measureRuntimeProfileStageSync(
        runtimeProfile,
        'usage.dataset.attribute_machine_remotes',
        () => attributeMachinesToLocalRepositories(parseResultsForFiltering, machines, moved.roots),
      );

      // After the worktrees, so a worktree's usage follows its repository's alias. Every
      // machine's events: an alias is often the path the project has on another machine.
      if (config.projectAliases) {
        const aliasOf = createProjectAliasResolver(config.projectAliases);
        const aliased = moveEventRepoRoots(
          parseResultsForFiltering.map((result) => result.events),
          aliasOf,
        );
        parseResultsForFiltering = parseResultsForFiltering.map((result, index) => ({
          ...result,
          events: aliased[index] ?? result.events,
        }));
        repoFilter = moveRepoFilterPaths(repoFilter, aliasOf);
      }
    }

    const { filteredEvents, lookbackEvents } = measureRuntimeProfileStageSync(
      runtimeProfile,
      'usage.dataset.filter_events',
      () => {
        const filtered = filterParsedAdapterEventsWithLookback(parseResultsForFiltering, {
          timezone: normalizedInputs.timezone,
          since: configuredOptions.since,
          until: configuredOptions.until,
          providerFilter: normalizedInputs.providerFilter,
          modelFilter: normalizedInputs.modelFilter,
          lookbackSince: request.lookbackSince,
        });

        // After the model filter, which picks exact or substring matching over all projects.
        return {
          filteredEvents: applyRepoFilter(filtered.events, repoFilter),
          lookbackEvents: applyRepoFilter(filtered.lookbackEvents, repoFilter),
        };
      },
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
        ...worktreeWarnings,
        ...findUnmatchedFilterWarnings({
          parseResults: parseResultsForFiltering,
          // Only a typed --source: a `sources` list from config.toml is a standing default,
          // and value narrows `source` to its plans' sources.
          cliSourceFilter: normalizeSourceFilter(userConfigResolution.cliOptions.source),
          provider: configuredOptions.provider,
          modelFilter: normalizedInputs.modelFilter,
          repoFilter,
          timezone: normalizedInputs.timezone,
          since: configuredOptions.since,
          until: configuredOptions.until,
        }),
      ],
      notes: [...historyNotes, ...machineNotes],
      filteredEvents,
      lookbackEvents,
      parsedFiles,
      ledger,
      machines,
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

/**
 * Prices the dataset's events, or only `events`, a subset of them. Whether prices load
 * still depends on all of the dataset's events, so the load and its failure do not change.
 */
export async function applyPricingToUsageEventDataset(
  dataset: UsageEventDataset,
  deps: BuildUsageDataDeps = {},
  pricingLoadMode: PricingLoadMode = 'auto',
  {
    perRequestRates = true,
    events = dataset.filteredEvents,
  }: { perRequestRates?: boolean; events?: UsageEvent[] } = {},
): Promise<UsageEventDatasetPricingResult> {
  const loadPricingSource = deps.resolvePricingSource ?? resolvePricingSource;
  const pricingOptions = withNormalizedPricingUrl(
    dataset.options,
    dataset.normalizedInputs.pricingUrl,
  );

  return measureRuntimeProfileStage(deps.runtimeProfile, 'usage.pricing.apply', () =>
    resolveAndApplyPricingToEvents(events, pricingOptions, {
      runtimeConfig: dataset.pricingRuntimeConfig,
      loadPricingSource,
      pricingLoadMode,
      loadDecisionEvents: dataset.filteredEvents,
      policy: resolvePricingPolicy(pricingOptions, perRequestRates),
    }),
  );
}

const MAX_NAMED_UNPRICED_MODELS = 5;

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

  const eventCount = pluralize(unpricedEvents.length, 'event');

  if (costMode === 'explicit') {
    return `~ marks costs that leave out ${eventCount} with no logged cost (--cost-mode explicit)`;
  }

  const models = [...new Set(unpricedEvents.map((event) => event.model ?? 'unknown'))].sort();
  const modelList = truncateNames(models, MAX_NAMED_UNPRICED_MODELS).join(', ');

  return `~ marks costs that leave out ${eventCount} with no known price (models: ${modelList})`;
}

/** The note naming events priced at a model's priority rates, if any are shown. */
function describePriorityPricedEvents(
  events: readonly UsageEvent[],
  priorityPriced: PricedEventsResult['pricingStats']['priorityPriced'],
): string | undefined {
  const priorityEvents = events.filter((event) => priorityPriced.has(event));

  if (priorityEvents.length === 0) {
    return undefined;
  }

  const models = [...new Set(priorityEvents.map((event) => event.model ?? 'unknown'))].sort();
  const modelList = truncateNames(models, MAX_NAMED_UNPRICED_MODELS).join(', ');

  return `${pluralize(priorityEvents.length, 'event')} priced at LiteLLM priority rates because no standard rate is listed (models: ${modelList})`;
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

  return `${pluralize(reestimatedEvents.length, 'event')} logged $0 by ${sources} ${verb} estimated from LiteLLM; use --cost-mode explicit to keep $0`;
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
  notes: readonly ReportNote[],
  shownEvents: readonly UsageEvent[],
  pricingResult: PricingNotesInput,
): ReportNote[] {
  const reestimatedNote = describeReestimatedExplicitZero(shownEvents, pricingResult);
  const pricingNotes = [
    describeUnpricedEvents(shownEvents, pricingResult.pricingPolicy.costMode),
    reestimatedNote === undefined ? undefined : { verbose: reestimatedNote },
    describePriorityPricedEvents(shownEvents, pricingResult.pricingStats.priorityPriced),
  ].filter((note) => note !== undefined);

  return [...notes, ...pricingNotes];
}
