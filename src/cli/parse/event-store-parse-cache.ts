import type { UsageEvent } from '../../domain/usage-event.js';
import type { replaceFilesEvents as replaceDefaultFilesEvents } from '../../persistence/event-store.js';
import {
  serializeEventStoreFingerprint,
  type EventStore,
  type EventStoreFileEntry,
  type EventStoreFileFingerprint,
} from '../../persistence/event-store.js';
import type {
  SourceParseFileDiagnostics,
  SourceSkippedRowReasonStat,
} from '../../sources/source-adapter.js';
import type { RuntimeProfileCollector } from '../runtime-profile.js';

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
  now: () => number;
  failureState: EventStoreFailureState;
};

export function getErrorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function recordEventStoreFailure(state: EventStoreFailureState, error: unknown): void {
  if (state.disabled) {
    return;
  }

  state.disabled = true;
  state.warning = `Event store disabled after failure: ${getErrorReason(error)}`;
}

export function readParsedFileFromEventStore(
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

export type ParsedFileStoreWrite = {
  source: string;
  filePath: string;
  fingerprint: EventStoreFileFingerprint;
  events: UsageEvent[];
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
      files.map((file) => ({ ...file, now })),
    );
  } catch (error) {
    recordEventStoreFailure(context.failureState, error);
  }
}
