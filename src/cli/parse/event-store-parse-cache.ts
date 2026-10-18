import type { ParseFileDiagnostics, UsageEvent } from '../../domain/usage-event.js';
import type {
  claimOverrideOnlyFiles as claimDefaultOverrideOnlyFiles,
  replaceFilesEvents as replaceDefaultFilesEvents,
} from '../../persistence/event-store.js';
import {
  serializeEventStoreFingerprint,
  type EventStore,
  type EventStoreFileEntry,
  type EventStoreFileFingerprint,
  type StoredSessionEvent,
} from '../../persistence/event-store.js';
import type { SourceSkippedRowReasonStat } from '@ayagmar/agent-sessions';
import { asRecord } from '@ayagmar/agent-sessions/internal';
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
 * The fingerprint the store holds for a file, for a source whose dependency list follows
 * its file (see `getFileFingerprint`). Undefined when there is none or it does not parse.
 */
export function readStoredFileFingerprint(
  context: EventStoreParseContext,
  params: { source: string; filePath: string },
): EventStoreFileFingerprint | undefined {
  if (context.failureState.disabled) {
    return undefined;
  }

  let storedEntry: EventStoreFileEntry | undefined;

  try {
    storedEntry = context.getFileEntry(context.store, params.source, params.filePath);
  } catch (error) {
    recordEventStoreFailure(context.failureState, error);
    return undefined;
  }

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
  params: { source: string; filePath: string; fingerprint: EventStoreFileFingerprint },
): boolean {
  if (context.failureState.disabled) {
    return false;
  }

  try {
    const storedEntry = context.getFileEntry(context.store, params.source, params.filePath);
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
  },
): ParseFileDiagnostics | undefined {
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

export type ParsedFileStoreWrite = {
  source: string;
  filePath: string;
  fingerprint: EventStoreFileFingerprint;
  events: UsageEvent[];
  sessionEvents?: readonly StoredSessionEvent[];
  skippedRows: number;
  skippedRowReasons: SourceSkippedRowReasonStat[];
};

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
