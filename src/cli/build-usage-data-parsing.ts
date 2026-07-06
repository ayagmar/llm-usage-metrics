import { stat } from 'node:fs/promises';

import type { EventStoreRuntimeConfig } from '../config/runtime-overrides.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { matchesCanonicalProviderFilter } from '../domain/provider-normalization.js';
import {
  closeEventStore as closeDefaultEventStore,
  getFileEntry as getDefaultEventStoreFileEntry,
  openEventStore as openDefaultEventStore,
  readFileEvents as readDefaultEventStoreFileEvents,
  replaceFileEvents as replaceDefaultFileEvents,
  serializeEventStoreFingerprint,
  type EventStore,
  type EventStoreDependencyFingerprint,
  type EventStoreFileEntry,
  type EventStoreFileFingerprint,
} from '../persistence/event-store.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import type {
  SourceAdapter,
  SourceParseFileDiagnostics,
  SourceSkippedRowReasonStat,
} from '../sources/source-adapter.js';
import { normalizeSkippedRowReasons } from './normalize-skipped-row-reasons.js';
import { getPeriodKey } from '../utils/time-buckets.js';
import type { RuntimeProfileCollector } from './runtime-profile.js';

import type { UsageSourceFailure } from './usage-data-contracts.js';

export type AdapterParseResult = {
  source: string;
  events: UsageEvent[];
  filesFound: number;
  skippedRows: number;
  skippedRowReasons: SourceSkippedRowReasonStat[];
};

export type ParsedAdaptersResult = {
  successfulParseResults: AdapterParseResult[];
  sourceFailures: UsageSourceFailure[];
  warnings: string[];
};

export type ParseSelectedAdaptersOptions = {
  eventStore?: EventStoreRuntimeConfig;
  eventStoreDeps?: EventStoreParseDeps;
  now?: () => number;
  runtimeProfile?: RuntimeProfileCollector;
};

type RunWithParseBudget = <T>(task: () => Promise<T>) => Promise<T>;

type ParseDependencyFingerprint = EventStoreDependencyFingerprint;

export type EventStoreParseDeps = {
  openEventStore?: (filePath: string) => Promise<EventStore>;
  closeEventStore?: (store: EventStore) => void;
  getFileEntry?: (
    store: EventStore,
    source: string,
    filePath: string,
  ) => EventStoreFileEntry | undefined;
  readFileEvents?: (
    store: EventStore,
    source: string,
    filePath: string,
  ) => UsageEvent[] | undefined;
  replaceFileEvents?: typeof replaceDefaultFileEvents;
};

type EventStoreFailureState = {
  disabled: boolean;
  warning?: string;
};

type EventStoreParseContext = {
  store: EventStore;
  getFileEntry: (
    store: EventStore,
    source: string,
    filePath: string,
  ) => EventStoreFileEntry | undefined;
  readFileEvents: (store: EventStore, source: string, filePath: string) => UsageEvent[] | undefined;
  replaceFileEvents: typeof replaceDefaultFileEvents;
  now: () => number;
  failureState: EventStoreFailureState;
};

function getDefaultParseFileDiagnostics(events: UsageEvent[]): SourceParseFileDiagnostics {
  return { events, skippedRows: 0, skippedRowReasons: [] };
}

function normalizeSkippedRowsCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function createParseDependencyFingerprint(
  filePath: string,
  options: { allowMissing: boolean },
): Promise<ParseDependencyFingerprint | undefined> {
  try {
    const fileStat = await stat(filePath);

    return {
      path: filePath,
      exists: true,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch (error) {
    if (options.allowMissing && isMissingPathError(error)) {
      return {
        path: filePath,
        exists: false,
      };
    }

    return undefined;
  }
}

async function getParseFileFingerprint(
  adapter: SourceAdapter,
  filePath: string,
): Promise<{ dependencies: ParseDependencyFingerprint[] } | undefined> {
  const primaryFingerprint = await createParseDependencyFingerprint(filePath, {
    allowMissing: false,
  });

  if (!primaryFingerprint) {
    return undefined;
  }

  const additionalDependencyPaths = adapter.getParseDependencies
    ? await adapter.getParseDependencies(filePath)
    : [];
  const uniqueAdditionalDependencyPaths = [...new Set(additionalDependencyPaths)]
    .filter((dependencyPath) => dependencyPath !== filePath)
    .sort(compareByCodePoint);
  const dependencyFingerprints: ParseDependencyFingerprint[] = [primaryFingerprint];

  for (const dependencyPath of uniqueAdditionalDependencyPaths) {
    const dependencyFingerprint = await createParseDependencyFingerprint(dependencyPath, {
      allowMissing: true,
    });

    if (!dependencyFingerprint) {
      return undefined;
    }

    dependencyFingerprints.push(dependencyFingerprint);
  }

  return {
    dependencies: dependencyFingerprints,
  };
}

function recordEventStoreFailure(state: EventStoreFailureState, error: unknown): void {
  if (state.disabled) {
    return;
  }

  state.disabled = true;
  state.warning = `Event store disabled after failure: ${getErrorReason(error)}`;
}

function readParsedFileFromEventStore(
  context: EventStoreParseContext,
  params: {
    source: string;
    filePath: string;
    fingerprint: EventStoreFileFingerprint;
    runtimeProfile?: RuntimeProfileCollector;
  },
): SourceParseFileDiagnostics | undefined {
  if (context.failureState.disabled) {
    return undefined;
  }

  try {
    const fingerprint = serializeEventStoreFingerprint(params.fingerprint);
    const storedEntry = context.getFileEntry(context.store, params.source, params.filePath);

    if (storedEntry?.fingerprint !== fingerprint) {
      params.runtimeProfile?.recordEventStoreResult(params.source, 'miss');
      return undefined;
    }

    const events = context.readFileEvents(context.store, params.source, params.filePath);

    if (!events) {
      params.runtimeProfile?.recordEventStoreResult(params.source, 'miss');
      return undefined;
    }

    params.runtimeProfile?.recordEventStoreResult(params.source, 'hit');

    return {
      events,
      skippedRows: storedEntry.skippedRows,
      skippedRowReasons: storedEntry.skippedRowReasons,
    };
  } catch (error) {
    recordEventStoreFailure(context.failureState, error);
    return undefined;
  }
}

function writeParsedFileToEventStore(
  context: EventStoreParseContext,
  params: {
    source: string;
    filePath: string;
    fingerprint: EventStoreFileFingerprint;
    events: UsageEvent[];
    skippedRows: number;
    skippedRowReasons: SourceSkippedRowReasonStat[];
  },
): void {
  if (context.failureState.disabled) {
    return;
  }

  // Only called after a store miss, so the stored fingerprint already differs.
  try {
    context.replaceFileEvents(context.store, {
      source: params.source,
      filePath: params.filePath,
      fingerprint: params.fingerprint,
      events: params.events,
      skippedRows: params.skippedRows,
      skippedRowReasons: params.skippedRowReasons,
      now: context.now(),
    });
  } catch (error) {
    recordEventStoreFailure(context.failureState, error);
  }
}

function createParseBudget(maxParallelFileParsing: number): RunWithParseBudget {
  const safeMaxParallelFileParsing =
    Number.isFinite(maxParallelFileParsing) && maxParallelFileParsing > 0
      ? Math.max(1, Math.floor(maxParallelFileParsing))
      : 1;
  let availablePermits = safeMaxParallelFileParsing;
  const waitingResolvers: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (availablePermits > 0) {
      availablePermits -= 1;
      return;
    }

    await new Promise<void>((resolve) => {
      waitingResolvers.push(resolve);
    });
  }

  function release(): void {
    const nextResolver = waitingResolvers.shift();

    if (nextResolver) {
      nextResolver();
      return;
    }

    availablePermits += 1;
  }

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();

    try {
      return await task();
    } finally {
      release();
    }
  };
}

export async function parseAdapterEvents(
  adapter: SourceAdapter,
  maxParallelFileParsing: number,
  runWithParseBudget: RunWithParseBudget = async <T>(task: () => Promise<T>) => task(),
  runtimeProfile?: RuntimeProfileCollector,
  eventStore?: EventStoreParseContext,
): Promise<AdapterParseResult> {
  const files = await adapter.discoverFiles();

  if (files.length === 0) {
    return {
      source: adapter.id,
      events: [],
      filesFound: 0,
      skippedRows: 0,
      skippedRowReasons: [],
    };
  }

  const safeMaxParallelFileParsing =
    Number.isFinite(maxParallelFileParsing) && maxParallelFileParsing > 0
      ? Math.max(1, Math.floor(maxParallelFileParsing))
      : 1;
  const parsedByFile: UsageEvent[][] = Array.from({ length: files.length }, () => []);
  const skippedRowsByFile: number[] = Array.from({ length: files.length }, () => 0);
  const skippedRowReasons = new Map<string, number>();
  const workerCount = Math.min(safeMaxParallelFileParsing, files.length);
  let nextFileIndex = 0;
  let failedFiles = 0;
  let lastErrorMessage = '';

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextFileIndex < files.length) {
      const fileIndex = nextFileIndex;
      nextFileIndex += 1;

      await runWithParseBudget(async () => {
        const filePath = files[fileIndex];

        try {
          let fileFingerprint: { dependencies: ParseDependencyFingerprint[] } | undefined;
          let parseFileDiagnostics: SourceParseFileDiagnostics | undefined;
          let servedFromEventStore = false;

          if (eventStore && !eventStore.failureState.disabled) {
            fileFingerprint = await getParseFileFingerprint(adapter, filePath);
          }

          if (eventStore && fileFingerprint) {
            parseFileDiagnostics = readParsedFileFromEventStore(eventStore, {
              source: adapter.id,
              filePath,
              fingerprint: fileFingerprint,
              runtimeProfile,
            });
            servedFromEventStore = parseFileDiagnostics !== undefined;
          }

          parseFileDiagnostics ??= adapter.parseFileWithDiagnostics
            ? await adapter.parseFileWithDiagnostics(filePath)
            : getDefaultParseFileDiagnostics(await adapter.parseFile(filePath));

          const skippedRows = normalizeSkippedRowsCount(parseFileDiagnostics.skippedRows);
          const normalizedSkippedRowReasons = normalizeSkippedRowReasons(
            parseFileDiagnostics.skippedRowReasons,
          );

          parsedByFile[fileIndex] = parseFileDiagnostics.events;
          skippedRowsByFile[fileIndex] = skippedRows;
          for (const reasonStat of normalizedSkippedRowReasons) {
            skippedRowReasons.set(
              reasonStat.reason,
              (skippedRowReasons.get(reasonStat.reason) ?? 0) + reasonStat.count,
            );
          }
          if (eventStore && fileFingerprint && !servedFromEventStore) {
            writeParsedFileToEventStore(eventStore, {
              source: adapter.id,
              filePath,
              fingerprint: fileFingerprint,
              events: parseFileDiagnostics.events,
              skippedRows,
              skippedRowReasons: normalizedSkippedRowReasons,
            });
          }
        } catch (error) {
          failedFiles += 1;
          lastErrorMessage = getErrorReason(error);
          skippedRowsByFile[fileIndex] = 1;
          skippedRowReasons.set(
            'file_parse_failed',
            (skippedRowReasons.get('file_parse_failed') ?? 0) + 1,
          );
        }
      });
    }
  });

  await Promise.all(workers);

  if (failedFiles === files.length) {
    throw new Error(
      `All ${files.length} file(s) failed to parse for source ${adapter.id}: ${lastErrorMessage}`,
    );
  }

  const result = {
    source: adapter.id,
    events: parsedByFile.flat(),
    filesFound: files.length,
    skippedRows: skippedRowsByFile.reduce((sum, skippedRowsCount) => sum + skippedRowsCount, 0),
    skippedRowReasons: [...skippedRowReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => compareByCodePoint(left.reason, right.reason)),
  };

  runtimeProfile?.recordParseResult(adapter.id, {
    filesFound: result.filesFound,
    eventsParsed: result.events.length,
  });

  return result;
}

function getErrorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function parseSelectedAdapters(
  adaptersToParse: SourceAdapter[],
  maxParallelFileParsing: number,
  options: ParseSelectedAdaptersOptions = {},
): Promise<ParsedAdaptersResult> {
  const runWithParseBudget = createParseBudget(maxParallelFileParsing);
  const eventStoreFailureState: EventStoreFailureState = { disabled: false };
  let eventStoreContext: EventStoreParseContext | undefined;

  if (options.eventStore?.enabled) {
    try {
      const openEventStore = options.eventStoreDeps?.openEventStore ?? openDefaultEventStore;
      eventStoreContext = {
        store: await openEventStore(options.eventStore.path),
        getFileEntry: options.eventStoreDeps?.getFileEntry ?? getDefaultEventStoreFileEntry,
        readFileEvents: options.eventStoreDeps?.readFileEvents ?? readDefaultEventStoreFileEvents,
        replaceFileEvents: options.eventStoreDeps?.replaceFileEvents ?? replaceDefaultFileEvents,
        now: options.now ?? Date.now,
        failureState: eventStoreFailureState,
      };
    } catch (error) {
      recordEventStoreFailure(eventStoreFailureState, error);
    }
  }

  let parseResults: Array<PromiseSettledResult<AdapterParseResult>>;

  try {
    parseResults = await Promise.allSettled(
      adaptersToParse.map((adapter) =>
        options.runtimeProfile
          ? options.runtimeProfile.measure(`parse.adapter.${adapter.id}`, () =>
              parseAdapterEvents(
                adapter,
                maxParallelFileParsing,
                runWithParseBudget,
                options.runtimeProfile,
                eventStoreContext,
              ),
            )
          : parseAdapterEvents(
              adapter,
              maxParallelFileParsing,
              runWithParseBudget,
              undefined,
              eventStoreContext,
            ),
      ),
    );
  } finally {
    if (eventStoreContext) {
      try {
        const closeEventStore = options.eventStoreDeps?.closeEventStore ?? closeDefaultEventStore;
        closeEventStore(eventStoreContext.store);
      } catch (error) {
        recordEventStoreFailure(eventStoreFailureState, error);
      }
    }
  }

  const sourceFailures: UsageSourceFailure[] = [];
  const successfulParseResults: AdapterParseResult[] = [];

  for (const [index, parseResult] of parseResults.entries()) {
    const source = adaptersToParse[index].id;

    if (parseResult.status === 'fulfilled') {
      successfulParseResults.push(parseResult.value);
      continue;
    }

    sourceFailures.push({ source, reason: getErrorReason(parseResult.reason) });
  }

  return {
    successfulParseResults,
    sourceFailures,
    warnings: eventStoreFailureState.warning ? [eventStoreFailureState.warning] : [],
  };
}

export function throwOnExplicitSourceFailures(
  sourceFailures: UsageSourceFailure[],
  explicitSourceIds: ReadonlySet<string>,
): void {
  const explicitFailures = sourceFailures.filter((failure) =>
    explicitSourceIds.has(failure.source.toLowerCase()),
  );

  if (explicitFailures.length === 0) {
    return;
  }

  const details = explicitFailures
    .map((failure) => `${failure.source}: ${failure.reason}`)
    .join('; ');

  throw new Error(`Failed to parse explicitly requested source(s): ${details}`);
}

function isEventWithinDateRange(
  eventDate: string,
  since: string | undefined,
  until: string | undefined,
): boolean {
  if (since && eventDate < since) {
    return false;
  }

  if (until && eventDate > until) {
    return false;
  }

  return true;
}

type ModelFilterRule = {
  value: string;
  mode: 'exact' | 'substring';
};

function resolveModelFilterRules(
  events: UsageEvent[],
  modelFilter: string[] | undefined,
): ModelFilterRule[] | undefined {
  if (!modelFilter || modelFilter.length === 0) {
    return undefined;
  }

  const availableModels = new Set(
    events
      .map((event) => event.model?.toLowerCase())
      .filter((model): model is string => Boolean(model)),
  );

  return modelFilter.map((value) => ({
    value,
    mode: availableModels.has(value) ? 'exact' : 'substring',
  }));
}

function matchesModel(
  model: string | undefined,
  modelRules: ModelFilterRule[] | undefined,
): boolean {
  if (!modelRules || modelRules.length === 0) {
    return true;
  }

  if (!model) {
    return false;
  }

  const normalizedModel = model.toLowerCase();

  return modelRules.some((rule) =>
    rule.mode === 'exact' ? normalizedModel === rule.value : normalizedModel.includes(rule.value),
  );
}

export type UsageEventFilterOptions = {
  timezone: string;
  since?: string;
  until?: string;
  providerFilter?: string;
  modelFilter?: string[];
};

function filterByModelRules(events: UsageEvent[], modelFilter: string[] | undefined): UsageEvent[] {
  const modelFilterRules = resolveModelFilterRules(events, modelFilter);

  return events.filter((event) => matchesModel(event.model, modelFilterRules));
}

function collectProviderAndDateFilteredEvents(
  eventGroups: Iterable<readonly UsageEvent[]>,
  options: UsageEventFilterOptions,
): UsageEvent[] {
  const filteredEvents: UsageEvent[] = [];
  const hasDateRange = Boolean(options.since ?? options.until);
  const dateByTimestamp = new Map<string, string>();

  for (const events of eventGroups) {
    for (const event of events) {
      if (!matchesCanonicalProviderFilter(event.provider, options.providerFilter)) {
        continue;
      }

      if (hasDateRange) {
        let eventDate = dateByTimestamp.get(event.timestamp);

        if (!eventDate) {
          eventDate = getPeriodKey(event.timestamp, 'daily', options.timezone);
          dateByTimestamp.set(event.timestamp, eventDate);
        }

        if (!isEventWithinDateRange(eventDate, options.since, options.until)) {
          continue;
        }
      }

      filteredEvents.push(event);
    }
  }

  return filteredEvents;
}

export function filterUsageEvents(
  events: UsageEvent[],
  options: UsageEventFilterOptions,
): UsageEvent[] {
  const providerAndDateFilteredEvents = collectProviderAndDateFilteredEvents([events], options);
  return filterByModelRules(providerAndDateFilteredEvents, options.modelFilter);
}

export function filterParsedAdapterEvents(
  parseResults: AdapterParseResult[],
  options: UsageEventFilterOptions,
): UsageEvent[] {
  const providerAndDateFilteredEvents = collectProviderAndDateFilteredEvents(
    parseResults.map((result) => result.events),
    options,
  );
  return filterByModelRules(providerAndDateFilteredEvents, options.modelFilter);
}
