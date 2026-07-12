import type { EventStoreRuntimeConfig } from '../config/runtime-overrides.js';
import type { UsageEvent } from '../domain/usage-event.js';
import {
  closeEventStore as closeDefaultEventStore,
  getFileEntry as getDefaultEventStoreFileEntry,
  openEventStore as openDefaultEventStore,
  readFileEvents as readDefaultEventStoreFileEvents,
  replaceFileEvents as replaceDefaultFileEvents,
  type EventStore,
  type EventStoreFileFingerprint,
} from '../persistence/event-store.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import type {
  SourceAdapter,
  SourceParseFileDiagnostics,
  SourceSkippedRowReasonStat,
} from '../sources/source-adapter.js';
import { normalizeSkippedRowReasons } from './normalize-skipped-row-reasons.js';
import {
  getErrorReason,
  readParsedFileFromEventStore,
  recordEventStoreFailure,
  writeParsedFileToEventStore,
  type EventStoreFailureState,
  type EventStoreParseContext,
  type EventStoreParseDeps,
} from './parse/event-store-parse-cache.js';
import { createParseBudget, type RunWithParseBudget } from './parse/parse-budget.js';
import {
  getFileByteSize,
  getParseFileFingerprint,
  getPrimaryFingerprintByteSize,
} from './parse/parse-fingerprint.js';
import type { RuntimeProfileCollector } from './runtime-profile.js';
import {
  canParseSourceOnWorker,
  createParseWorkerPool,
  type ParseWorkerPool,
} from './parse-worker-pool.js';

import type { UsageSourceFailure } from './usage-data-contracts.js';

export type AdapterParseResult = {
  source: string;
  events: UsageEvent[];
  filesFound: number;
  skippedRows: number;
  skippedRowReasons: SourceSkippedRowReasonStat[];
};

export type DiscoveredSourceFile = {
  source: string;
  filePath: string;
};

type AdapterParseResultWithFiles = AdapterParseResult & {
  filePaths: string[];
};

export type ParsedAdaptersResult = {
  successfulParseResults: AdapterParseResult[];
  discoveredFiles: DiscoveredSourceFile[];
  eventStoreAvailable: boolean;
  sourceFailures: UsageSourceFailure[];
  warnings: string[];
};

export type ParseSelectedAdaptersOptions = {
  eventStore?: EventStoreRuntimeConfig;
  eventStoreDeps?: EventStoreParseDeps;
  openedStore?: EventStore;
  now?: () => number;
  parseWorkers?: ParseWorkerRuntimeOptions;
  runtimeProfile?: RuntimeProfileCollector;
};

type ParseWorkerRuntimeOptions = {
  workerCount: number;
  minBytes: number;
  entryUrl?: URL;
  createPool?: typeof createParseWorkerPool;
};

type MissedParseFile = {
  fileIndex: number;
  filePath: string;
  fileFingerprint?: EventStoreFileFingerprint;
  byteSize: number;
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

function getSafeWorkerCount(workerCount: number): number {
  if (!Number.isFinite(workerCount) || workerCount <= 0) {
    return 0;
  }

  return Math.floor(workerCount);
}

function getSafeWorkerMinBytes(minBytes: number): number {
  if (!Number.isFinite(minBytes) || minBytes <= 0) {
    return 0;
  }

  return Math.floor(minBytes);
}

export async function parseAdapterEvents(
  adapter: SourceAdapter,
  maxParallelFileParsing: number,
  runWithParseBudget: RunWithParseBudget = async <T>(task: () => Promise<T>) => task(),
  runtimeProfile?: RuntimeProfileCollector,
  eventStore?: EventStoreParseContext,
  parseWorkerOptions?: ParseWorkerRuntimeOptions,
): Promise<AdapterParseResultWithFiles> {
  const files = await adapter.discoverFiles();

  if (files.length === 0) {
    return {
      source: adapter.id,
      events: [],
      filePaths: [],
      filesFound: 0,
      skippedRows: 0,
      skippedRowReasons: [],
    } satisfies AdapterParseResultWithFiles;
  }

  const safeMaxParallelFileParsing =
    Number.isFinite(maxParallelFileParsing) && maxParallelFileParsing > 0
      ? Math.max(1, Math.floor(maxParallelFileParsing))
      : 1;
  const parsedByFile: UsageEvent[][] = Array.from({ length: files.length }, () => []);
  const skippedRowsByFile: number[] = Array.from({ length: files.length }, () => 0);
  const skippedRowReasons = new Map<string, number>();
  let failedFiles = 0;
  let lastErrorMessage = '';

  function recordParseFailure(fileIndex: number, error: unknown): void {
    failedFiles += 1;
    lastErrorMessage = getErrorReason(error);
    skippedRowsByFile[fileIndex] = 1;
    skippedRowReasons.set(
      'file_parse_failed',
      (skippedRowReasons.get('file_parse_failed') ?? 0) + 1,
    );
  }

  async function parseFileInline(filePath: string): Promise<SourceParseFileDiagnostics> {
    return adapter.parseFileWithDiagnostics
      ? await adapter.parseFileWithDiagnostics(filePath)
      : getDefaultParseFileDiagnostics(await adapter.parseFile(filePath));
  }

  function recordParsedFile(params: {
    fileIndex: number;
    filePath: string;
    fileFingerprint?: EventStoreFileFingerprint;
    diagnostics: SourceParseFileDiagnostics;
    servedFromEventStore: boolean;
  }): void {
    const skippedRows = normalizeSkippedRowsCount(params.diagnostics.skippedRows);
    const normalizedSkippedRowReasons = normalizeSkippedRowReasons(
      params.diagnostics.skippedRowReasons,
    );

    parsedByFile[params.fileIndex] = params.diagnostics.events;
    skippedRowsByFile[params.fileIndex] = skippedRows;

    for (const reasonStat of normalizedSkippedRowReasons) {
      skippedRowReasons.set(
        reasonStat.reason,
        (skippedRowReasons.get(reasonStat.reason) ?? 0) + reasonStat.count,
      );
    }

    if (eventStore && params.fileFingerprint && !params.servedFromEventStore) {
      writeParsedFileToEventStore(eventStore, {
        source: adapter.id,
        filePath: params.filePath,
        fingerprint: params.fileFingerprint,
        events: params.diagnostics.events,
        skippedRows,
        skippedRowReasons: normalizedSkippedRowReasons,
      });
    }
  }

  async function runTaskLoop<T>(
    tasks: readonly T[],
    runTask: (task: T) => Promise<void>,
  ): Promise<void> {
    const workerCount = Math.min(safeMaxParallelFileParsing, tasks.length);
    let nextTaskIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
      while (nextTaskIndex < tasks.length) {
        const task = tasks[nextTaskIndex];
        nextTaskIndex += 1;

        await runWithParseBudget(() => runTask(task));
      }
    });

    await Promise.all(workers);
  }

  async function parseFileAtIndexInline(fileIndex: number): Promise<void> {
    const filePath = files[fileIndex];

    try {
      let fileFingerprint: EventStoreFileFingerprint | undefined;
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

      parseFileDiagnostics ??= await parseFileInline(filePath);

      recordParsedFile({
        fileIndex,
        filePath,
        fileFingerprint,
        diagnostics: parseFileDiagnostics,
        servedFromEventStore,
      });
    } catch (error) {
      recordParseFailure(fileIndex, error);
    }
  }

  async function resolveStoreHitOrWorkerMiss(
    fileIndex: number,
    missedFiles: MissedParseFile[],
  ): Promise<void> {
    const filePath = files[fileIndex];

    try {
      let fileFingerprint: EventStoreFileFingerprint | undefined;
      let parseFileDiagnostics: SourceParseFileDiagnostics | undefined;

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
      }

      if (parseFileDiagnostics) {
        recordParsedFile({
          fileIndex,
          filePath,
          fileFingerprint,
          diagnostics: parseFileDiagnostics,
          servedFromEventStore: true,
        });
        return;
      }

      missedFiles.push({
        fileIndex,
        filePath,
        fileFingerprint,
        byteSize:
          getPrimaryFingerprintByteSize(fileFingerprint) ?? (await getFileByteSize(filePath)),
      });
    } catch (error) {
      recordParseFailure(fileIndex, error);
    }
  }

  async function parseMissedFileInline(missedFile: MissedParseFile): Promise<void> {
    try {
      const diagnostics = await parseFileInline(missedFile.filePath);
      recordParsedFile({
        fileIndex: missedFile.fileIndex,
        filePath: missedFile.filePath,
        fileFingerprint: missedFile.fileFingerprint,
        diagnostics,
        servedFromEventStore: false,
      });
    } catch (error) {
      recordParseFailure(missedFile.fileIndex, error);
    }
  }

  async function parseMissedFileOnPool(
    pool: ParseWorkerPool,
    missedFile: MissedParseFile,
  ): Promise<void> {
    try {
      const diagnostics = await pool.parse(
        {
          sourceId: adapter.id,
          filePath: missedFile.filePath,
        },
        () => parseFileInline(missedFile.filePath),
      );
      recordParsedFile({
        fileIndex: missedFile.fileIndex,
        filePath: missedFile.filePath,
        fileFingerprint: missedFile.fileFingerprint,
        diagnostics,
        servedFromEventStore: false,
      });
    } catch (error) {
      recordParseFailure(missedFile.fileIndex, error);
    }
  }

  async function parseWorkerEligibleFiles(fileIndices: number[]): Promise<void> {
    const safeWorkerCount = getSafeWorkerCount(parseWorkerOptions?.workerCount ?? 0);
    const minWorkerBytes = getSafeWorkerMinBytes(parseWorkerOptions?.minBytes ?? 0);

    if (safeWorkerCount === 0) {
      runtimeProfile?.recordParseWorkerResult(adapter.id, {
        status: 'off',
        workerCount: 0,
        missedBytes: 0,
      });
      await runTaskLoop(fileIndices, parseFileAtIndexInline);
      return;
    }

    const missedFiles: MissedParseFile[] = [];
    await runTaskLoop(fileIndices, (fileIndex) =>
      resolveStoreHitOrWorkerMiss(fileIndex, missedFiles),
    );
    missedFiles.sort((left, right) => left.fileIndex - right.fileIndex);

    const missedBytes = missedFiles.reduce(
      (sum, missedFile) => sum + Math.max(0, missedFile.byteSize),
      0,
    );

    if (missedFiles.length === 0 || missedBytes < minWorkerBytes) {
      runtimeProfile?.recordParseWorkerResult(adapter.id, {
        status: 'off',
        workerCount: safeWorkerCount,
        missedBytes,
      });
      await runTaskLoop(missedFiles, parseMissedFileInline);
      return;
    }

    const workerCount = Math.min(safeWorkerCount, missedFiles.length);
    const createPool = parseWorkerOptions?.createPool ?? createParseWorkerPool;
    const pool = createPool({
      entryUrl: parseWorkerOptions?.entryUrl ?? new URL(import.meta.url),
      workerCount,
    });
    let status: 'engaged' | 'fallback' = pool.status() === 'fallback' ? 'fallback' : 'engaged';

    try {
      await runTaskLoop(missedFiles, (missedFile) => parseMissedFileOnPool(pool, missedFile));
      status = pool.status() === 'fallback' ? 'fallback' : status;
    } finally {
      await pool.terminate();
    }

    runtimeProfile?.recordParseWorkerResult(adapter.id, {
      status,
      workerCount,
      missedBytes,
    });
  }

  const fileIndices = files.map((_, index) => index);

  if (canParseSourceOnWorker(adapter.id)) {
    await parseWorkerEligibleFiles(fileIndices);
  } else {
    await runTaskLoop(fileIndices, parseFileAtIndexInline);
  }

  if (failedFiles === files.length) {
    throw new Error(
      `All ${files.length} file(s) failed to parse for source ${adapter.id}: ${lastErrorMessage}`,
    );
  }

  const result = {
    source: adapter.id,
    events: parsedByFile.flat(),
    filePaths: files,
    filesFound: files.length,
    skippedRows: skippedRowsByFile.reduce((sum, skippedRowsCount) => sum + skippedRowsCount, 0),
    skippedRowReasons: [...skippedRowReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => compareByCodePoint(left.reason, right.reason)),
  } satisfies AdapterParseResultWithFiles;

  runtimeProfile?.recordParseResult(adapter.id, {
    filesFound: result.filesFound,
    eventsParsed: result.events.length,
  });

  return result;
}

export async function parseSelectedAdapters(
  adaptersToParse: SourceAdapter[],
  maxParallelFileParsing: number,
  options: ParseSelectedAdaptersOptions = {},
): Promise<ParsedAdaptersResult> {
  const runWithParseBudget = createParseBudget(maxParallelFileParsing);
  const eventStoreFailureState: EventStoreFailureState = { disabled: false };
  let eventStoreContext: EventStoreParseContext | undefined;
  let ownsEventStore = false;

  if (options.eventStore?.enabled) {
    try {
      const openEventStore = options.eventStoreDeps?.openEventStore ?? openDefaultEventStore;
      const store = options.openedStore ?? (await openEventStore(options.eventStore.path));
      ownsEventStore = options.openedStore === undefined;
      eventStoreContext = {
        store,
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

  let parseResults: Array<PromiseSettledResult<AdapterParseResultWithFiles>>;

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
                options.parseWorkers,
              ),
            )
          : parseAdapterEvents(
              adapter,
              maxParallelFileParsing,
              runWithParseBudget,
              undefined,
              eventStoreContext,
              options.parseWorkers,
            ),
      ),
    );
  } finally {
    if (eventStoreContext && ownsEventStore) {
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
  const discoveredFiles: DiscoveredSourceFile[] = [];

  for (const [index, parseResult] of parseResults.entries()) {
    const source = adaptersToParse[index].id;

    if (parseResult.status === 'fulfilled') {
      const { filePaths, ...parseResultWithoutFiles } = parseResult.value;
      successfulParseResults.push(parseResultWithoutFiles);
      discoveredFiles.push(
        ...filePaths.map((filePath) => ({
          source,
          filePath,
        })),
      );
      continue;
    }

    sourceFailures.push({ source, reason: getErrorReason(parseResult.reason) });
  }

  return {
    successfulParseResults,
    discoveredFiles,
    eventStoreAvailable: Boolean(options.eventStore?.enabled) && !eventStoreFailureState.disabled,
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
