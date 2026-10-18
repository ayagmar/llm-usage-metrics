import { collectFile, dedupeRepeatedAcrossFiles } from '@ayagmar/agent-sessions';

import type { EventStoreRuntimeConfig } from '../config/runtime-overrides.js';
import { withCostModes, type UsageEvent } from '../domain/usage-event.js';
import {
  claimOverrideOnlyFiles as claimDefaultOverrideOnlyFiles,
  closeEventStore as closeDefaultEventStore,
  getFileEntry as getDefaultEventStoreFileEntry,
  getFileReadCursor as getDefaultFileReadCursor,
  openEventStore as openDefaultEventStore,
  readFileEvents as readDefaultEventStoreFileEvents,
  replaceFilesEvents as replaceDefaultFilesEvents,
  type EventStore,
  type EventStoreFileFingerprint,
} from '../persistence/event-store.js';
import type { SourceAdapter, SourceSkippedRowReasonStat } from '@ayagmar/agent-sessions';
import { normalizeSkippedRowReasons } from './normalize-skipped-row-reasons.js';
import {
  claimFilesInUsualLocations,
  isStoredFileCurrent,
  joinResumedRead,
  readParsedFileFromEventStore,
  readResumePoint,
  recordEventStoreFailure,
  writeParsedFilesToEventStore,
  type EventStoreFailureState,
  type EventStoreParseContext,
  type EventStoreParseDeps,
  type ParsedFileStoreWrite,
  type StoredResumePoint,
} from './parse/event-store-parse-cache.js';
import { createParseBudget, type RunWithParseBudget } from './parse/parse-budget.js';
import {
  collectFileForEventStore,
  getEventStoreFileFingerprint,
  withStoreCostModes,
  type ParsedFileForEventStore,
} from './parse/stored-session-events.js';
import {
  compareByCodePoint,
  getFileByteSize,
  getNewestFingerprintMtimeMs,
  getPrimaryFingerprintByteSize,
  pluralize,
} from '@ayagmar/agent-sessions/internal';
import { getSinceFileSkipCutoffMs } from './parse/since-file-skip.js';
import type { RuntimeProfileCollector } from './runtime-profile.js';
import {
  canParseSourceOnWorker,
  createParseWorkerPool,
  getParseWorkerRoots,
  type ParseWorkerPool,
} from './parse-worker-pool.js';

import type { UsageSourceFailure } from './usage-data-contracts.js';
import { getErrorReason } from '../utils/get-error-reason.js';

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

/** A file whose events this run counts. */
export type ParsedSourceFile = DiscoveredSourceFile & {
  /**
   * Last modified before the `--since` window, so it holds no events in it: parsed only
   * because the event store lacked it.
   */
  beforeWindow?: true;
  /**
   * Parsed with the event store on, but not stored: its fingerprint could not be read, so
   * the store may hold none or an older version of its events.
   */
  unstored?: true;
};

type AdapterParseResultWithFiles = AdapterParseResult & {
  filePaths: string[];
  /** The discovered files whose events this run counts: neither failed nor skipped. */
  parsedFiles: Omit<ParsedSourceFile, 'source'>[];
  failedFilePaths: string[];
};

export type ParsedAdaptersResult = {
  successfulParseResults: AdapterParseResult[];
  discoveredFiles: DiscoveredSourceFile[];
  parsedFiles: ParsedSourceFile[];
  /** Discovered files that failed to parse: present, but not counted this run. */
  failedFiles: DiscoveredSourceFile[];
  eventStoreAvailable: boolean;
  sourceFailures: UsageSourceFailure[];
  warnings: string[];
};

export type ParseSelectedAdaptersOptions = {
  eventStore?: EventStoreRuntimeConfig;
  /** The report's `--since` date; lets adapters skip files last modified before it. */
  since?: string;
  eventStoreDeps?: EventStoreParseDeps;
  openedStore?: EventStore;
  /** Lowercase ids of the sources read from a custom directory (--claude-dir...). */
  overrideSourceIds?: ReadonlySet<string>;
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

/** The run's one parse pool, created when a source first sends it work. */
type SharedParseWorkerPool = {
  get(): ParseWorkerPool;
  terminate(): Promise<void>;
};

/**
 * Parse misses are written to the event store in batches: one transaction per file
 * fsyncs and rewrites the same index pages, while one per source holds the write lock
 * and a second copy of every event for too long.
 */
const STORE_WRITE_BATCH_EVENTS = 5_000;

type FileLookup =
  | { kind: 'skipped' }
  | {
      kind: 'hit';
      fileFingerprint: EventStoreFileFingerprint;
      diagnostics: ParsedFileForEventStore;
    }
  | {
      kind: 'miss';
      fileFingerprint?: EventStoreFileFingerprint;
      /** Set when the read can start where the stored version's read ended. */
      resumePoint?: StoredResumePoint;
    };

type MissedParseFile = {
  fileIndex: number;
  filePath: string;
  fileFingerprint?: EventStoreFileFingerprint;
  byteSize: number;
};

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

function createSharedParseWorkerPool(
  parseWorkerOptions: ParseWorkerRuntimeOptions | undefined,
): SharedParseWorkerPool {
  let pool: ParseWorkerPool | undefined;

  return {
    get: () => {
      const createPool = parseWorkerOptions?.createPool ?? createParseWorkerPool;
      pool ??= createPool({
        entryUrl: parseWorkerOptions?.entryUrl ?? new URL(import.meta.url),
        workerCount: getSafeWorkerCount(parseWorkerOptions?.workerCount ?? 0),
      });
      return pool;
    },
    terminate: async () => {
      await pool?.terminate();
    },
  };
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
  since?: string,
  sharedPool?: SharedParseWorkerPool,
): Promise<AdapterParseResultWithFiles> {
  const files = await adapter.discoverFiles();
  const skipCutoffMs = adapter.capabilities?.eventsPrecedeFileMtime
    ? getSinceFileSkipCutoffMs(since)
    : undefined;

  if (files.length === 0) {
    return {
      source: adapter.id,
      events: [],
      filePaths: [],
      parsedFiles: [],
      failedFilePaths: [],
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
  const parsedFileIndexes = new Set<number>();
  const beforeWindowFileIndexes = new Set<number>();
  const unstoredFileIndexes = new Set<number>();
  const failedFileIndexes = new Set<number>();
  const skippedRowReasons = new Map<string, number>();
  let pendingStoreWrites: ParsedFileStoreWrite[] = [];
  let pendingStoreEventCount = 0;
  let lastErrorMessage = '';

  function recordParseFailure(fileIndex: number, error: unknown): void {
    failedFileIndexes.add(fileIndex);
    lastErrorMessage = getErrorReason(error);
    skippedRowsByFile[fileIndex] = 1;
    skippedRowReasons.set(
      'file_parse_failed',
      (skippedRowReasons.get('file_parse_failed') ?? 0) + 1,
    );
  }

  /** A file is read for the store, with what it keeps besides usage, when it will be stored. */
  function isReadForEventStore(fileFingerprint: EventStoreFileFingerprint | undefined): boolean {
    return (
      eventStore !== undefined && !eventStore.failureState.disabled && fileFingerprint !== undefined
    );
  }

  async function parseFileInline(
    filePath: string,
    fileFingerprint: EventStoreFileFingerprint | undefined,
    resumePoint?: StoredResumePoint,
  ): Promise<ParsedFileForEventStore> {
    return isReadForEventStore(fileFingerprint)
      ? withStoreCostModes(
          await collectFileForEventStore(adapter, filePath, { from: resumePoint?.cursor }),
        )
      : withCostModes(await collectFile(adapter, filePath));
  }

  function recordParsedFile(params: {
    fileIndex: number;
    filePath: string;
    fileFingerprint?: EventStoreFileFingerprint;
    diagnostics: ParsedFileForEventStore;
    servedFromEventStore: boolean;
    resumePoint?: StoredResumePoint;
  }): void {
    const { diagnostics: read, resumePoint } = params;
    const resumedReplacing = resumePoint ? read.resumedReplacing : undefined;
    // A resumed read holds only the appended lines; the file's events include the stored ones.
    const diagnostics =
      resumePoint && resumedReplacing
        ? joinResumedRead(resumePoint, { ...read, resumedReplacing })
        : read;
    const skippedRows = normalizeSkippedRowsCount(diagnostics.skippedRows);
    const normalizedSkippedRowReasons = normalizeSkippedRowReasons(diagnostics.skippedRowReasons);

    parsedByFile[params.fileIndex] = diagnostics.events;
    parsedFileIndexes.add(params.fileIndex);
    if (params.fileFingerprint && isBeforeWindow(params.fileFingerprint)) {
      beforeWindowFileIndexes.add(params.fileIndex);
    }
    if (eventStore && !params.fileFingerprint) {
      unstoredFileIndexes.add(params.fileIndex);
    }
    skippedRowsByFile[params.fileIndex] = skippedRows;

    for (const reasonStat of normalizedSkippedRowReasons) {
      skippedRowReasons.set(
        reasonStat.reason,
        (skippedRowReasons.get(reasonStat.reason) ?? 0) + reasonStat.count,
      );
    }

    if (eventStore && params.fileFingerprint && !params.servedFromEventStore) {
      pendingStoreWrites.push({
        source: adapter.id,
        filePath: params.filePath,
        fingerprint: params.fileFingerprint,
        events: read.events,
        sessionEvents: read.sessionEvents,
        skippedRows,
        skippedRowReasons: normalizedSkippedRowReasons,
        readCursor: read.readCursor,
        ...(resumePoint &&
          resumedReplacing && {
            append: {
              expectedFingerprint: resumePoint.storedFingerprint,
              replaced: resumedReplacing,
            },
          }),
      });
      // Tool calls and messages are rows to write and memory held until the flush too.
      pendingStoreEventCount += read.events.length + (read.sessionEvents?.length ?? 0);

      if (pendingStoreEventCount >= STORE_WRITE_BATCH_EVENTS) {
        flushPendingStoreWrites();
      }
    }
  }

  function flushPendingStoreWrites(): void {
    if (eventStore && pendingStoreWrites.length > 0) {
      writeParsedFilesToEventStore(eventStore, pendingStoreWrites);
    }

    pendingStoreWrites = [];
    pendingStoreEventCount = 0;
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

  /** A file last modified before the `--since` window holds no events in it. */
  function isBeforeWindow(fileFingerprint: EventStoreFileFingerprint): boolean {
    return (
      skipCutoffMs !== undefined && getNewestFingerprintMtimeMs(fileFingerprint) < skipCutoffMs
    );
  }

  /**
   * A file before the window is skipped. With the event store on, only a file the store
   * already holds is skipped: a narrow run must still ingest older files, or the ledger
   * would never retain them.
   */
  function canSkipOutsideWindow(
    filePath: string,
    fileFingerprint: EventStoreFileFingerprint | undefined,
  ): boolean {
    if (!fileFingerprint || !isBeforeWindow(fileFingerprint)) {
      return false;
    }

    if (!eventStore || eventStore.failureState.disabled) {
      return true;
    }

    return isStoredFileCurrent(eventStore, {
      source: adapter.id,
      filePath,
      fingerprint: fileFingerprint,
    });
  }

  async function lookUpFile(filePath: string): Promise<FileLookup> {
    const storeEnabled = eventStore !== undefined && !eventStore.failureState.disabled;
    const fileFingerprint =
      storeEnabled || skipCutoffMs !== undefined
        ? await getEventStoreFileFingerprint(adapter, filePath)
        : undefined;

    if (canSkipOutsideWindow(filePath, fileFingerprint)) {
      return { kind: 'skipped' };
    }

    if (eventStore && fileFingerprint) {
      const diagnostics = readParsedFileFromEventStore(eventStore, {
        source: adapter.id,
        filePath,
        fingerprint: fileFingerprint,
        runtimeProfile,
      });

      if (diagnostics) {
        return { kind: 'hit', fileFingerprint, diagnostics };
      }

      if (adapter.capabilities?.incremental) {
        const resumePoint = readResumePoint(eventStore, {
          source: adapter.id,
          filePath,
          fingerprint: fileFingerprint,
        });
        return { kind: 'miss', fileFingerprint, resumePoint };
      }
    }

    return { kind: 'miss', fileFingerprint };
  }

  /** Reads a missed file here, resuming from the stored cursor when there is one. */
  async function parseMissInline(
    fileIndex: number,
    filePath: string,
    lookup: Extract<FileLookup, { kind: 'miss' }>,
  ): Promise<void> {
    recordParsedFile({
      fileIndex,
      filePath,
      fileFingerprint: lookup.fileFingerprint,
      diagnostics: await parseFileInline(filePath, lookup.fileFingerprint, lookup.resumePoint),
      servedFromEventStore: false,
      resumePoint: lookup.resumePoint,
    });
  }

  async function parseFileAtIndexInline(fileIndex: number): Promise<void> {
    const filePath = files[fileIndex];

    try {
      const lookup = await lookUpFile(filePath);

      if (lookup.kind === 'skipped') {
        return;
      }

      if (lookup.kind === 'miss') {
        await parseMissInline(fileIndex, filePath, lookup);
        return;
      }

      recordParsedFile({
        fileIndex,
        filePath,
        fileFingerprint: lookup.fileFingerprint,
        diagnostics: lookup.diagnostics,
        servedFromEventStore: true,
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
      const lookup = await lookUpFile(filePath);

      if (lookup.kind === 'skipped') {
        return;
      }

      if (lookup.kind === 'hit') {
        recordParsedFile({
          fileIndex,
          filePath,
          fileFingerprint: lookup.fileFingerprint,
          diagnostics: lookup.diagnostics,
          servedFromEventStore: true,
        });
        return;
      }

      // A resumed read only covers the appended lines: too little for a worker.
      if (lookup.resumePoint) {
        await parseMissInline(fileIndex, filePath, lookup);
        return;
      }

      missedFiles.push({
        fileIndex,
        filePath,
        fileFingerprint: lookup.fileFingerprint,
        byteSize:
          getPrimaryFingerprintByteSize(lookup.fileFingerprint) ??
          (await getFileByteSize(filePath)),
      });
    } catch (error) {
      recordParseFailure(fileIndex, error);
    }
  }

  async function parseMissedFileInline(missedFile: MissedParseFile): Promise<void> {
    try {
      await parseMissInline(missedFile.fileIndex, missedFile.filePath, {
        kind: 'miss',
        fileFingerprint: missedFile.fileFingerprint,
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
          roots: getParseWorkerRoots(adapter, missedFile.filePath),
          forEventStore: isReadForEventStore(missedFile.fileFingerprint),
        },
        () => parseFileInline(missedFile.filePath, missedFile.fileFingerprint),
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
        workerLimit: 0,
        missedBytes: 0,
      });
      await runTaskLoop(fileIndices, parseFileAtIndexInline);
      return;
    }

    const missedFiles: MissedParseFile[] = [];
    await runTaskLoop(fileIndices, (fileIndex) =>
      resolveStoreHitOrWorkerMiss(fileIndex, missedFiles),
    );
    missedFiles.sort((left, right) => {
      if (left.byteSize !== right.byteSize) {
        return right.byteSize - left.byteSize;
      }

      return left.fileIndex - right.fileIndex;
    });

    const missedBytes = missedFiles.reduce(
      (sum, missedFile) => sum + Math.max(0, missedFile.byteSize),
      0,
    );

    if (missedFiles.length === 0 || missedBytes < minWorkerBytes) {
      runtimeProfile?.recordParseWorkerResult(adapter.id, {
        status: 'off',
        workerLimit: safeWorkerCount,
        missedBytes,
      });
      await runTaskLoop(missedFiles, parseMissedFileInline);
      return;
    }

    const workerCount = Math.min(safeWorkerCount, missedFiles.length);
    const runPool = sharedPool ?? createSharedParseWorkerPool(parseWorkerOptions);
    const pool = runPool.get();
    let status: 'engaged' | 'fallback' = pool.status() === 'fallback' ? 'fallback' : 'engaged';

    try {
      await runTaskLoop(missedFiles, (missedFile) => parseMissedFileOnPool(pool, missedFile));
      status = pool.status() === 'fallback' ? 'fallback' : status;
    } finally {
      if (!sharedPool) {
        await runPool.terminate();
      }
    }

    runtimeProfile?.recordParseWorkerResult(adapter.id, {
      status,
      workerLimit: workerCount,
      missedBytes,
    });
  }

  const fileIndices = files.map((_, index) => index);

  if (canParseSourceOnWorker(adapter.id)) {
    await parseWorkerEligibleFiles(fileIndices);
  } else {
    await runTaskLoop(fileIndices, parseFileAtIndexInline);
  }

  flushPendingStoreWrites();

  if (failedFileIndexes.size === files.length) {
    throw new Error(
      `All ${pluralize(files.length, 'file')} failed to parse for source ${adapter.id}: ${lastErrorMessage}`,
    );
  }

  const result = {
    source: adapter.id,
    events: adapter.capabilities?.eventsRepeatAcrossFiles
      ? dedupeRepeatedAcrossFiles(parsedByFile)
      : parsedByFile.flat(),
    filePaths: files,
    parsedFiles: files.flatMap((filePath, fileIndex) =>
      parsedFileIndexes.has(fileIndex)
        ? [
            {
              filePath,
              ...(beforeWindowFileIndexes.has(fileIndex) && { beforeWindow: true as const }),
              ...(unstoredFileIndexes.has(fileIndex) && { unstored: true as const }),
            },
          ]
        : [],
    ),
    failedFilePaths: files.filter((_, fileIndex) => failedFileIndexes.has(fileIndex)),
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
        replaceFilesEvents: options.eventStoreDeps?.replaceFilesEvents ?? replaceDefaultFilesEvents,
        claimOverrideOnlyFiles:
          options.eventStoreDeps?.claimOverrideOnlyFiles ?? claimDefaultOverrideOnlyFiles,
        getFileReadCursor: options.eventStoreDeps?.getFileReadCursor ?? getDefaultFileReadCursor,
        now: options.now ?? Date.now,
        failureState: eventStoreFailureState,
        overrideSourceIds: options.overrideSourceIds ?? new Set(),
      };
    } catch (error) {
      recordEventStoreFailure(eventStoreFailureState, error);
    }
  }

  let parseResults: Array<PromiseSettledResult<AdapterParseResultWithFiles>>;
  let claimWarning: string | undefined;
  const sharedPool = createSharedParseWorkerPool(options.parseWorkers);

  try {
    parseResults = await Promise.allSettled(
      adaptersToParse.map((adapter) => {
        const parse = () =>
          parseAdapterEvents(
            adapter,
            maxParallelFileParsing,
            runWithParseBudget,
            options.runtimeProfile,
            eventStoreContext,
            options.parseWorkers,
            options.since,
            sharedPool,
          );

        return options.runtimeProfile
          ? options.runtimeProfile.measure(`parse.adapter.${adapter.id}`, parse)
          : parse();
      }),
    );

    if (eventStoreContext) {
      claimWarning = claimFilesInUsualLocations(
        eventStoreContext,
        parseResults.flatMap((parseResult) =>
          parseResult.status === 'fulfilled'
            ? parseResult.value.filePaths.map((filePath) => ({
                source: parseResult.value.source,
                filePath,
              }))
            : [],
        ),
      );
    }
  } finally {
    if (eventStoreContext && ownsEventStore) {
      try {
        const closeEventStore = options.eventStoreDeps?.closeEventStore ?? closeDefaultEventStore;
        closeEventStore(eventStoreContext.store);
      } catch (error) {
        recordEventStoreFailure(eventStoreFailureState, error);
      }
    }

    await sharedPool.terminate();
  }

  const sourceFailures: UsageSourceFailure[] = [];
  const successfulParseResults: AdapterParseResult[] = [];
  const discoveredFiles: DiscoveredSourceFile[] = [];
  const parsedFiles: ParsedSourceFile[] = [];
  const failedFiles: DiscoveredSourceFile[] = [];

  for (const [index, parseResult] of parseResults.entries()) {
    const source = adaptersToParse[index].id;

    if (parseResult.status === 'fulfilled') {
      const {
        filePaths,
        parsedFiles: sourceParsedFiles,
        failedFilePaths,
        ...parseResultWithoutFiles
      } = parseResult.value;
      successfulParseResults.push(parseResultWithoutFiles);
      discoveredFiles.push(...filePaths.map((filePath) => ({ source, filePath })));
      parsedFiles.push(...sourceParsedFiles.map((file) => ({ source, ...file })));
      failedFiles.push(...failedFilePaths.map((filePath) => ({ source, filePath })));
      continue;
    }

    sourceFailures.push({ source, reason: getErrorReason(parseResult.reason) });
  }

  return {
    successfulParseResults,
    discoveredFiles,
    parsedFiles,
    failedFiles,
    eventStoreAvailable: Boolean(options.eventStore?.enabled) && !eventStoreFailureState.disabled,
    sourceFailures,
    warnings: [eventStoreFailureState.warning, claimWarning].filter(
      (warning): warning is string => warning !== undefined,
    ),
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
