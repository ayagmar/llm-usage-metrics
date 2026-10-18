import {
  collectFile,
  createReadDiagnostics,
  readEvents,
  toParseDiagnostics,
  type ReadCursor,
  type ReplacedEventCounts,
  type SourceAdapter,
  type SourceParseFileDiagnostics,
  type UsageEvent,
  type UsageRecord,
} from '@ayagmar/agent-sessions';
import { getFileFingerprint, isReadReasonCode } from '@ayagmar/agent-sessions/internal';

import { withCostModes, type ParseFileDiagnostics } from '../../domain/usage-event.js';
import type {
  EventStoreFileFingerprint,
  StoredSessionEvent,
  StoredSessionEventKind,
} from '../../persistence/event-store.js';

// In the order the store fingerprint lists them.
const STORED_SESSION_EVENT_KINDS: readonly StoredSessionEventKind[] = ['message', 'tool_call'];

/** What a read of an incremental source adds for the event store. */
type ResumableRead = {
  /** Where the next read of the file resumes. */
  readCursor?: ReadCursor;
  /**
   * Set when the read resumed from the stored cursor: its events and skipped rows are only
   * those of the lines appended since, and they replace the last stored ones it counts.
   */
  resumedReplacing?: ReplacedEventCounts;
};

/** A file read for the event store: its usage as `collectFile` reads it, and what else it keeps. */
export type StoreParseFileDiagnostics = SourceParseFileDiagnostics &
  ResumableRead & {
    /** Tool calls and messages in read order; unset for a usage-only source. */
    sessionEvents?: StoredSessionEvent[];
  };

/** `StoreParseFileDiagnostics` as the CLI holds it: every usage event carries a cost mode. */
export type ParsedFileForEventStore = ParseFileDiagnostics &
  ResumableRead & {
    sessionEvents?: StoredSessionEvent[];
  };

export function withStoreCostModes(
  diagnostics: StoreParseFileDiagnostics,
): ParsedFileForEventStore {
  return {
    ...withCostModes(diagnostics),
    sessionEvents: diagnostics.sessionEvents,
    readCursor: diagnostics.readCursor,
    resumedReplacing: diagnostics.resumedReplacing,
  };
}

/** The kinds besides usage the event store keeps for the adapter's files. */
export function getStoredSessionEventKinds(
  adapter: Pick<SourceAdapter, 'capabilities'>,
): StoredSessionEventKind[] {
  const declared = adapter.capabilities?.kinds ?? [];
  return STORED_SESSION_EVENT_KINDS.filter((kind) => declared.includes(kind));
}

/**
 * The file's fingerprint with the kinds the store keeps for its source, so a file stored
 * while the store kept fewer kinds no longer matches and is read again. `previous` is the
 * fingerprint stored for the file, which `getFileFingerprint` may confirm instead of
 * asking the adapter for its dependencies.
 */
export async function getEventStoreFileFingerprint(
  adapter: SourceAdapter,
  filePath: string,
  previous?: EventStoreFileFingerprint,
): Promise<EventStoreFileFingerprint | undefined> {
  const fingerprint = await getFileFingerprint(adapter, filePath, previous);
  const storedKinds = getStoredSessionEventKinds(adapter);

  return fingerprint && storedKinds.length > 0 ? { ...fingerprint, storedKinds } : fingerprint;
}

function toUsageEvent(record: UsageRecord): UsageEvent {
  // The keys readEvents adds to the event `read` yields; the rest keep its order.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { kind, messageId, requestId, rawProvider, raw, ...event } = record;
  return event;
}

/**
 * Reads a file once for the event store. A source that declares tool calls or messages is
 * read with `readEvents` for usage and those kinds: its usage events and skipped rows are
 * what `collectFile` returns (the readEvents contract), and the other kinds' skipped rows
 * are left out. With `cursor`, an incremental source is read the same way under a cursor,
 * resuming from `cursor.from` when given. A read under a cursor leaves a last line without
 * a line feed unread, so such a file is read again without one, and kept without a cursor.
 * Any other source is read with `collectFile`.
 */
export async function collectFileForEventStore(
  adapter: SourceAdapter,
  filePath: string,
  options: { cursor?: { from?: ReadCursor } } = {},
): Promise<StoreParseFileDiagnostics> {
  const storedKinds = getStoredSessionEventKinds(adapter);
  const incremental = adapter.capabilities?.incremental === true && options.cursor !== undefined;

  if (storedKinds.length === 0 && !incremental) {
    return collectFile(adapter, filePath);
  }

  const diagnostics = createReadDiagnostics();
  const events: UsageEvent[] = [];
  const sessionEvents: StoredSessionEvent[] = [];
  const resumable: ResumableRead = {};
  const end = { partialLine: false };

  for await (const event of readEvents(adapter, filePath, {
    kinds: ['usage', ...storedKinds],
    diagnostics,
    resume: incremental
      ? {
          from: options.cursor?.from,
          onStart: ({ restarted, replaced }) => {
            resumable.resumedReplacing = restarted ? undefined : (replaced ?? {});
          },
          onCursor: (update) => {
            resumable.readCursor = update.cursor;
            end.partialLine = update.partialLine;
          },
        }
      : undefined,
  })) {
    if (event.kind === 'usage') {
      events.push(toUsageEvent(event));
    } else if (event.kind === 'tool_call' || event.kind === 'message') {
      sessionEvents.push(event);
    }
  }

  if (end.partialLine) {
    return collectFileForEventStore(adapter, filePath);
  }

  const readReasons = new Map<string, number>();
  let skippedRows = diagnostics.skippedRows;

  for (const [reason, count] of diagnostics.skippedRowReasons) {
    if (isReadReasonCode(reason)) {
      readReasons.set(reason, count);
    } else {
      skippedRows -= count;
    }
  }

  return {
    ...toParseDiagnostics(events, skippedRows, readReasons),
    ...(storedKinds.length > 0 && { sessionEvents }),
    ...resumable,
  };
}
