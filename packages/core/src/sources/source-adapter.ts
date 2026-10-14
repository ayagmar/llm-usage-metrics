import type { EventKind, SessionEvent } from '../domain/session-event.js';
import type { UsageEvent, SourceId } from '../domain/usage-event.js';
import type { SourceContext } from './source-context.js';

export type SourceSkippedRowReasonStat = {
  reason: string;
  count: number;
};

export type SourceCapabilities = {
  fixedProviderRoots?: readonly string[];
  /**
   * Every event a file yields is timestamped no later than the newest mtime of the file
   * and its parse dependencies, so a windowed run may skip files last modified before
   * the window. Leave it unset for SQLite sources: their events live in a shared database
   * whose sidecars and checkpoints do not track when each row was written.
   */
  eventsPrecedeFileMtime?: boolean;
  /**
   * A file can repeat events that another file of the source also holds (a pi fork copies
   * its parent's entries), so an event found in several files is counted once. Events are
   * the same when their content hashes match, which cover session id and timestamp.
   */
  eventsRepeatAcrossFiles?: boolean;
  /**
   * A session can copy another session's events under its own session id (a Claude
   * session continued in a new session repeats the rows it continues), so an event that
   * several sessions hold with the same timestamp, model and usage is counted once.
   */
  sessionsCopyEvents?: boolean;
  /**
   * The event kinds `readEvents` can yield. An adapter that leaves it unset is read as
   * `['usage']`.
   */
  kinds?: readonly EventKind[];
  /** Declared for later milestones; nothing reads these yet. */
  sqlite?: boolean;
  incremental?: boolean;
};

export type SourceAdapterPathOptions = {
  dir?: string;
  requireDir?: boolean;
  context?: SourceContext;
};

export type SourceParseFileDiagnostics<Event extends UsageEvent = UsageEvent> = {
  events: Event[];
  skippedRows: number;
  skippedRowReasons?: SourceSkippedRowReasonStat[];
};

/** Skipped-row counts a read adds to as it goes; complete only once the read finishes. */
export type SourceReadDiagnostics = {
  skippedRows: number;
  skippedRowReasons: Map<string, number>;
};

export type SourceReadOptions = {
  diagnostics?: SourceReadDiagnostics;
};

export type ReadEventsOptions = {
  /** The kinds to yield; every kind the adapter declares when omitted. */
  kinds?: readonly EventKind[];
  /** Include message text and session titles. Off by default: they are private data. */
  text?: boolean;
  /** Attach the parsed source record to each event as `raw`, text included. */
  raw?: boolean;
  diagnostics?: SourceReadDiagnostics;
};

export interface SourceAdapter<Event extends UsageEvent = UsageEvent> {
  readonly id: SourceId;
  /**
   * Bump whenever parsing the same unchanged file would produce different events
   * (token mapping, dedup, model resolution). It is part of the event-store cache key,
   * so a bump re-parses files that were stored by an older parser. Defaults to 1.
   */
  readonly parserVersion?: number;
  readonly capabilities?: SourceCapabilities;
  /** Directories or database files discovery looks in, for `doctor`. */
  getSearchPaths?(): readonly string[];
  discoverFiles(): Promise<string[]>;
  /**
   * Yields the file's events in order and adds skipped rows to `options.diagnostics` as
   * they happen. A read that throws may already have yielded events; breaking out closes
   * every handle the read opened before `return()` resolves.
   */
  read(filePath: string, options?: SourceReadOptions): AsyncIterable<Event>;
  /**
   * Yields the file's events of the requested kinds. Usage records keep `read`'s order;
   * every other kind is yielded when its event completes. Read it through the core
   * `readEvents`, which falls back to `read` for an adapter without this method.
   */
  readEvents?(filePath: string, options?: ReadEventsOptions): AsyncIterable<SessionEvent>;
  getParseDependencies?(filePath: string): Promise<string[]>;
}

/** The ids of the adapters whose sessions copy each other's events. */
export function getSessionCopyingSourceIds(adapters: readonly SourceAdapter[]): Set<string> {
  return new Set(
    adapters
      .filter((adapter) => adapter.capabilities?.sessionsCopyEvents)
      .map((adapter) => adapter.id),
  );
}

/** The ids of the adapters whose files repeat each other's events. */
export function getRepeatingSourceIds(adapters: readonly SourceAdapter[]): string[] {
  return adapters
    .filter((adapter) => adapter.capabilities?.eventsRepeatAcrossFiles)
    .map((adapter) => adapter.id);
}
