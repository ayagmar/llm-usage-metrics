import { copiedSessions } from '../dedup/copied-session.js';
import { repeatedAcrossFiles } from '../dedup/repeated-across-files.js';
import type { EventKind, SessionEvent } from '../domain/session-event.js';
import type {
  ReadEventsOptions,
  SourceAdapter,
  SourceReadDiagnostics,
} from '../sources/source-adapter.js';
import type { SourceContext } from '../sources/source-context.js';
import { collect } from '../stream/collect.js';
import { readEvents } from '../stream/read-events.js';
import { since, until } from '../stream/window.js';
import {
  createDefaultAdapters,
  getDefaultSourceIds,
  sourceSupportsDirectories,
} from './adapters.js';

/** Options for `readSources`. */
export type ReadSourcesOptions = {
  /** The kinds to yield; every kind each source declares when omitted. */
  kinds?: readonly EventKind[];
  /** Include message text and session titles. Off by default: they are private data. */
  text?: boolean;
  /** Attach the parsed source record to each event as `raw`, text included. */
  raw?: boolean;
  /** Keep events at or after this instant; applied after deduplication. */
  since?: string | Date;
  /** Keep events before this instant; applied after deduplication. */
  until?: string | Date;
  /**
   * Count repeated usage once, per source, as the CLI does (on by default). It buffers:
   * each file's events until the file is read, and a source whose sessions copy each
   * other (claude) in full, message bodies included when `text` or `raw` is on. With
   * `false`, events stream as each file yields them.
   */
  dedupe?: boolean;
  /**
   * The skipped-row counters a source's reads add to, asked for once per source after its
   * discovery succeeds.
   */
  diagnostics?: (sourceId: string) => SourceReadDiagnostics;
  /**
   * Roots per source id, instead of its default locations. An explicit root must exist; a
   * missing one is a discovery failure. A missing default root yields nothing. Each entry
   * needs at least one root, and exactly one for a source that reads a single database file
   * (opencode, goose).
   */
  roots?: ReadonlyMap<string, readonly string[]>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Without a diagnostic listener the failure is the caller's to handle.
function reportFailure(
  context: SourceContext,
  error: unknown,
  diagnostic: { source: string; message: string; path?: string },
): void {
  if (!context.onDiagnostic) {
    throw error;
  }

  context.onDiagnostic({ level: 'warn', ...diagnostic });
}

async function* readFileBatches(
  adapter: SourceAdapter,
  files: readonly string[],
  readOptions: ReadEventsOptions,
  context: SourceContext,
): AsyncGenerator<SessionEvent[]> {
  for (const file of files) {
    let events: SessionEvent[];

    try {
      events = await collect(readEvents(adapter, file, readOptions));
    } catch (error) {
      // Like the CLI, a file whose read throws counts none of its events.
      reportFailure(context, error, {
        source: adapter.id,
        path: file,
        message: `read failed: ${errorMessage(error)}`,
      });
      continue;
    }

    yield events;
  }
}

async function* streamFiles(
  adapter: SourceAdapter,
  files: readonly string[],
  readOptions: ReadEventsOptions,
  context: SourceContext,
): AsyncGenerator<SessionEvent> {
  for (const file of files) {
    try {
      yield* readEvents(adapter, file, readOptions);
    } catch (error) {
      // The events the file yielded before the throw are already out.
      reportFailure(context, error, {
        source: adapter.id,
        path: file,
        message: `read failed: ${errorMessage(error)}`,
      });
    }
  }
}

async function* flatten<T>(batches: AsyncIterable<readonly T[]>): AsyncGenerator<T> {
  for await (const batch of batches) {
    yield* batch;
  }
}

function dedupeSource(
  adapter: SourceAdapter,
  batches: AsyncIterable<SessionEvent[]>,
): AsyncIterable<SessionEvent> {
  const events = adapter.capabilities?.eventsRepeatAcrossFiles
    ? repeatedAcrossFiles<SessionEvent>()(batches)
    : flatten(batches);

  return adapter.capabilities?.sessionsCopyEvents ? copiedSessions<SessionEvent>()(events) : events;
}

async function* readAdapters(
  adapters: readonly SourceAdapter[],
  context: SourceContext,
  options: ReadSourcesOptions,
): AsyncGenerator<SessionEvent> {
  for (const adapter of adapters) {
    let files: string[];

    try {
      files = await adapter.discoverFiles();
    } catch (error) {
      reportFailure(context, error, {
        source: adapter.id,
        message: `discovery failed: ${errorMessage(error)}`,
      });
      continue;
    }

    const readOptions: ReadEventsOptions = {
      kinds: options.kinds,
      text: options.text,
      raw: options.raw,
      diagnostics: options.diagnostics?.(adapter.id),
    };

    yield* options.dedupe === false
      ? streamFiles(adapter, files, readOptions, context)
      : dedupeSource(adapter, readFileBatches(adapter, files, readOptions, context));
  }
}

/**
 * Reads every file of the `ids` sources: sources in registry order whatever order `ids`
 * lists them in, files in discovery order, and each file's events as `readEvents` yields
 * them. Usage that a source repeats is counted once unless `dedupe` is `false`, and the
 * `since`/`until` window applies after that.
 *
 * A source whose discovery throws is skipped, and so is a file whose read throws: each is
 * reported to `context.onDiagnostic` as a warning, or rethrown when there is no listener.
 * With `dedupe` on, a failed file yields none of its events, as in the CLI; with it off,
 * the events it yielded before the throw stay.
 *
 * An unknown source id, a `roots` entry for a source not in `ids`, an empty `roots` entry,
 * several roots for a single-file source, or an invalid window bound throws here, before
 * any read.
 */
export function readSources(
  context: SourceContext,
  ids: readonly string[],
  options: ReadSourcesOptions = {},
): AsyncIterable<SessionEvent> {
  const knownIds = new Set(getDefaultSourceIds());
  const unknownIds = ids.filter((id) => !knownIds.has(id));

  if (unknownIds.length > 0) {
    throw new Error(
      `readSources: unknown source id(s) ${unknownIds.join(', ')}; expected one of ${[...knownIds].join(', ')}`,
    );
  }

  const selectedIds = new Set(ids);
  const unselectedRootIds = [...(options.roots?.keys() ?? [])].filter((id) => !selectedIds.has(id));

  if (unselectedRootIds.length > 0) {
    throw new Error(
      `readSources: roots given for source id(s) ${unselectedRootIds.join(', ')} that ids does not select; add them to ids or drop their roots`,
    );
  }

  for (const [id, sourceRoots] of options.roots ?? []) {
    if (sourceRoots.length === 0) {
      throw new Error(
        `readSources: roots for ${id} is empty; give at least one root, or drop the entry to read its default locations`,
      );
    }

    if (sourceRoots.length > 1 && !sourceSupportsDirectories(id)) {
      throw new Error(
        `readSources: ${id} reads one database file, so it takes one root, not ${sourceRoots.length}`,
      );
    }
  }

  const keepSince = options.since === undefined ? undefined : since<SessionEvent>(options.since);
  const keepUntil = options.until === undefined ? undefined : until<SessionEvent>(options.until);
  const roots = options.roots ?? new Map<string, readonly string[]>();

  // Built lazily, so the iterable reads nothing until it is iterated.
  async function* read(): AsyncGenerator<SessionEvent> {
    const adapters = createDefaultAdapters(
      { sourceIds: ids, roots, requireExistingRoots: new Set(roots.keys()) },
      context,
    );
    let events: AsyncIterable<SessionEvent> = readAdapters(adapters, context, options);

    if (keepSince) {
      events = keepSince(events);
    }

    if (keepUntil) {
      events = keepUntil(events);
    }

    yield* events;
  }

  return read();
}
