import type { ParseFileDiagnostics, UsageEvent } from '../../domain/usage-event.js';
import type {
  claimOverrideOnlyFiles as claimDefaultOverrideOnlyFiles,
  getFileReadCursor as getDefaultFileReadCursor,
  replaceFilesEvents as replaceDefaultFilesEvents,
} from '../../persistence/event-store.js';
import {
  serializeEventStoreFingerprint,
  type EventStore,
  type EventStoreAppend,
  type EventStoreFileEntry,
  type EventStoreFileFingerprint,
  type StoredSessionEvent,
} from '../../persistence/event-store.js';
import {
  toParseDiagnostics,
  type ReadCursor,
  type SourceSkippedRowReasonStat,
} from '@ayagmar/agent-sessions';
import { asRecord } from '@ayagmar/agent-sessions/internal';
import type { ParsedFileForEventStore } from './stored-session-events.js';
import type { RuntimeProfileCollector } from '../runtime-profile.js';
import { getErrorReason } from '../../utils/get-error-reason.js';

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
  replaceFilesEvents?: typeof replaceDefaultFilesEvents;
  claimOverrideOnlyFiles?: typeof claimDefaultOverrideOnlyFiles;
  getFileReadCursor?: typeof getDefaultFileReadCursor;
};

export type EventStoreFailureState = {
  disabled: boolean;
  warning?: string;
};

export type EventStoreParseContext = {
  store: EventStore;
  getFileEntry: (
    store: EventStore,
    source: string,
    filePath: string,
  ) => EventStoreFileEntry | undefined;
  readFileEvents: (store: EventStore, source: string, filePath: string) => UsageEvent[] | undefined;
  replaceFilesEvents: typeof replaceDefaultFilesEvents;
  claimOverrideOnlyFiles: typeof claimDefaultOverrideOnlyFiles;
  getFileReadCursor: typeof getDefaultFileReadCursor;
  now: () => number;
  failureState: EventStoreFailureState;
  /** Lowercase ids of the sources this run reads from a custom directory. */
  overrideSourceIds: ReadonlySet<string>;
};

export function recordEventStoreFailure(state: EventStoreFailureState, error: unknown): void {
  if (state.disabled) {
    return;
  }

  state.disabled = true;
  state.warning = `Event store disabled after failure: ${getErrorReason(error)}`;
}

/**
 * The store's entry for a file, read once by a caller that needs it before the lookup
 * (see `parseStoredFileFingerprint`); pass it on as `storedEntry`.
 */
export function readStoredFileEntry(
  context: EventStoreParseContext,
  params: { source: string; filePath: string },
): EventStoreFileEntry | undefined {
  if (context.failureState.disabled) {
    return undefined;
  }

  try {
    return context.getFileEntry(context.store, params.source, params.filePath);
  } catch (error) {
    recordEventStoreFailure(context.failureState, error);
    return undefined;
  }
}

/**
 * The fingerprint a store entry holds, for a source whose dependency list follows its file
 * (see `getFileFingerprint`). Undefined when there is none or it does not parse.
 */
export function parseStoredFileFingerprint(
  storedEntry: EventStoreFileEntry | undefined,
): EventStoreFileFingerprint | undefined {
  let fingerprint: Record<string, unknown> | undefined;

  try {
    fingerprint = storedEntry && asRecord(JSON.parse(storedEntry.fingerprint));
  } catch {
    return undefined;
  }

  const dependencies: EventStoreFileFingerprint['dependencies'] = [];

  for (const value of Array.isArray(fingerprint?.dependencies) ? fingerprint.dependencies : []) {
    const dependency = asRecord(value);

    if (typeof dependency?.path !== 'string') {
      return undefined;
    }

    dependencies.push({
      path: dependency.path,
      exists: dependency.exists === true,
      size: typeof dependency.size === 'number' ? dependency.size : undefined,
      mtimeMs: typeof dependency.mtimeMs === 'number' ? dependency.mtimeMs : undefined,
    });
  }

  return fingerprint && dependencies.length > 0
    ? {
        parserVersion:
          typeof fingerprint.parserVersion === 'string' ? fingerprint.parserVersion : undefined,
        dependencies,
      }
    : undefined;
}

/** Whether the store already holds this exact version of the file. */
export function isStoredFileCurrent(
  context: EventStoreParseContext,
  params: {
    source: string;
    filePath: string;
    fingerprint: EventStoreFileFingerprint;
    /** The file's entry, when the caller already read it. */
    storedEntry?: EventStoreFileEntry;
  },
): boolean {
  if (context.failureState.disabled) {
    return false;
  }

  try {
    const storedEntry =
      params.storedEntry ?? context.getFileEntry(context.store, params.source, params.filePath);
    return storedEntry?.fingerprint === serializeEventStoreFingerprint(params.fingerprint);
  } catch (error) {
    recordEventStoreFailure(context.failureState, error);
    return false;
  }
}

export function readParsedFileFromEventStore(
  context: EventStoreParseContext,
  params: {
    source: string;
    filePath: string;
    fingerprint: EventStoreFileFingerprint;
    runtimeProfile?: RuntimeProfileCollector;
    /** The file's entry, when the caller already read it. */
    storedEntry?: EventStoreFileEntry;
  },
): ParseFileDiagnostics | undefined {
  if (context.failureState.disabled) {
    return undefined;
  }

  try {
    const fingerprint = serializeEventStoreFingerprint(params.fingerprint);
    const storedEntry =
      params.storedEntry ?? context.getFileEntry(context.store, params.source, params.filePath);

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

export type ParsedFileStoreWrite = {
  source: string;
  filePath: string;
  fingerprint: EventStoreFileFingerprint;
  /** For an append, only the appended lines' events. */
  events: UsageEvent[];
  sessionEvents?: readonly StoredSessionEvent[];
  skippedRows: number;
  skippedRowReasons: SourceSkippedRowReasonStat[];
  readCursor?: ReadCursor;
  append?: EventStoreAppend;
};

/** A stored file a read can resume: its cursor, and the version and events it continues. */
export type StoredResumePoint = ParseFileDiagnostics & {
  cursor: ReadCursor;
  storedFingerprint: string;
};

/**
 * Whether only the file itself changed since `storedFingerprint`: the same parser
 * version, stored kinds and dependencies. A changed dependency (a fork's parent) can
 * change how the lines before the cursor parse, so it needs a whole read.
 */
function isOnlyFileChanged(
  storedFingerprint: string,
  fingerprint: EventStoreFileFingerprint,
): boolean {
  const [file, ...dependencies] = fingerprint.dependencies;
  const storedDependencies: unknown = asRecord(JSON.parse(storedFingerprint))?.dependencies;
  // The serialized list is sorted by path, so the file is not always first.
  const storedFile = Array.isArray(storedDependencies)
    ? storedDependencies.map(asRecord).find((dependency) => dependency?.path === file.path)
    : undefined;
  const size = storedFile?.size;
  const mtimeMs = storedFile?.mtimeMs;

  return (
    typeof size === 'number' &&
    typeof mtimeMs === 'number' &&
    serializeEventStoreFingerprint({
      ...fingerprint,
      dependencies: [{ ...file, size, mtimeMs }, ...dependencies],
    }) === storedFingerprint
  );
}

/**
 * A stored file that only grew. Its read keeps a cursor, so only files seen growing hold
 * one, and resumes from `resumePoint` when the stored version kept a cursor.
 */
export type StoredFileGrowth = { resumePoint?: StoredResumePoint };

/**
 * Whether a file that changed only grew since the stored version (only the file changed),
 * with that version's cursor and events when the store holds both. The read itself checks
 * that the file still starts with the bytes the cursor covers.
 */
export function readFileGrowth(
  context: EventStoreParseContext,
  params: { source: string; filePath: string; fingerprint: EventStoreFileFingerprint },
): StoredFileGrowth | undefined {
  if (context.failureState.disabled) {
    return undefined;
  }

  try {
    // One read snapshot: a version another run commits meanwhile cannot pair this
    // version's cursor with its events.
    context.store.database.exec('BEGIN');

    try {
      const storedEntry = context.getFileEntry(context.store, params.source, params.filePath);

      if (!storedEntry || !isOnlyFileChanged(storedEntry.fingerprint, params.fingerprint)) {
        return undefined;
      }

      const cursor = context.getFileReadCursor(context.store, params.source, params.filePath);
      const events =
        cursor && context.readFileEvents(context.store, params.source, params.filePath);

      return cursor && events
        ? {
            resumePoint: {
              cursor,
              storedFingerprint: storedEntry.fingerprint,
              events,
              skippedRows: storedEntry.skippedRows,
              skippedRowReasons: storedEntry.skippedRowReasons,
            },
          }
        : {};
    } finally {
      context.store.database.exec('COMMIT');
    }
  } catch (error) {
    recordEventStoreFailure(context.failureState, error);
    return undefined;
  }
}

/**
 * A resumed read joined to the stored version it continues: the stored events minus the
 * ones it replaces, then its own, and both versions' skipped rows.
 */
export function joinResumedRead(
  resumePoint: StoredResumePoint,
  read: ParsedFileForEventStore & {
    resumedReplacing: NonNullable<ParsedFileForEventStore['resumedReplacing']>;
  },
): ParseFileDiagnostics {
  const keptEvents = resumePoint.events.length - (read.resumedReplacing.usage ?? 0);
  const reasons = new Map<string, number>();

  for (const { reason, count } of [
    ...(resumePoint.skippedRowReasons ?? []),
    ...(read.skippedRowReasons ?? []),
  ]) {
    reasons.set(reason, (reasons.get(reason) ?? 0) + count);
  }

  return toParseDiagnostics(
    [...resumePoint.events.slice(0, keptEvents), ...read.events],
    resumePoint.skippedRows + read.skippedRows,
    reasons,
  );
}

export function writeParsedFilesToEventStore(
  context: EventStoreParseContext,
  files: readonly ParsedFileStoreWrite[],
): void {
  if (context.failureState.disabled || files.length === 0) {
    return;
  }

  // Only called for store misses, so each stored fingerprint already differs.
  try {
    const now = context.now();
    context.replaceFilesEvents(
      context.store,
      files.map((file) => ({
        ...file,
        now,
        overrideOnly: context.overrideSourceIds.has(file.source.toLowerCase()),
      })),
    );
  } catch (error) {
    recordEventStoreFailure(context.failureState, error);
  }
}

/**
 * Claims the files this run discovered in their sources' usual locations, so a file
 * first seen under a custom directory is served as history once it departs. A failure
 * only delays the claim, so it returns a warning instead of disabling the store.
 */
export function claimFilesInUsualLocations(
  context: EventStoreParseContext,
  files: readonly { source: string; filePath: string }[],
): string | undefined {
  if (context.failureState.disabled) {
    return undefined;
  }

  const usualLocationFiles = files.filter(
    (file) => !context.overrideSourceIds.has(file.source.toLowerCase()),
  );

  if (usualLocationFiles.length === 0) {
    return undefined;
  }

  try {
    context.claimOverrideOnlyFiles(context.store, usualLocationFiles);
    return undefined;
  } catch (error) {
    return `Event store could not record files found in their usual location: ${getErrorReason(error)}`;
  }
}
