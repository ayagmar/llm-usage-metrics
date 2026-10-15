import type { EventKind, SessionEvent } from '../domain/session-event.js';
import type { UsageEvent, SourceId } from '../domain/usage-event.js';
import type { ReadResume } from '../stream/cursor.js';
import type { SourceContext } from './source-context.js';

/** How many rows a read skipped for one reason. */
export type SourceSkippedRowReasonStat = {
  reason: string;
  count: number;
};

/** What an adapter declares about its source; every flag is optional and off when unset. */
export type SourceCapabilities = {
  /**
   * The billing providers this source's events belong to, when fixed. A provider filter
   * that matches none of them can skip the source.
   */
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
  /**
   * The adapter honours `resume`: it reads on from a valid cursor and reports a new one.
   * Check this before passing `resume`; any other adapter ignores it.
   */
  incremental?: boolean;
};

/** Constructor options shared by the directory-backed adapters. */
export type SourceAdapterPathOptions = {
  /** The directory to read; the source's default location when omitted. */
  dir?: string;
  /** Fail discovery when `dir` is missing, instead of finding no files. */
  requireDir?: boolean;
  /** Home directory, environment and platform; the host's when omitted. */
  context?: SourceContext;
};

/** A whole file's events and skipped rows, as `collectFile` returns them. */
export type SourceParseFileDiagnostics<Event extends UsageEvent = UsageEvent> = {
  events: Event[];
  skippedRows: number;
  /** Sorted by reason. */
  skippedRowReasons?: SourceSkippedRowReasonStat[];
};

/** Skipped-row counts a read adds to as it goes; complete only once the read finishes. */
export type SourceReadDiagnostics = {
  skippedRows: number;
  skippedRowReasons: Map<string, number>;
};

/** Options for `SourceAdapter.read`. */
export type SourceReadOptions = {
  diagnostics?: SourceReadDiagnostics;
  /** Resumes from a cursor; honoured only when `capabilities.incremental` is true. */
  resume?: ReadResume;
};

/** Options for `readEvents` and `SourceAdapter.readEvents`. */
export type ReadEventsOptions = {
  /** The kinds to yield; every kind the adapter declares when omitted. */
  kinds?: readonly EventKind[];
  /** Include message text and session titles. Off by default: they are private data. */
  text?: boolean;
  /** Attach the parsed source record to each event as `raw`, text included. */
  raw?: boolean;
  diagnostics?: SourceReadDiagnostics;
  /**
   * Resumes from a cursor; honoured only when `capabilities.incremental` is true, and
   * only when the read includes usage.
   */
  resume?: ReadResume;
};

/**
 * Reads one agent's local session store: finds its files and turns each into events.
 * Adapters are read-only, and their constructors read nothing from disk.
 */
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
  /**
   * The files to read, in a stable order. A missing default location finds none; a missing
   * required one throws.
   */
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
  /**
   * Other files the events of `filePath` depend on (a sidecar, a parent transcript). A
   * cache keyed on a file must also check these.
   */
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
