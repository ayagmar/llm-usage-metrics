import { createHash, type Hash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

import type { EventKind } from '../domain/session-event.js';
import { createReadDiagnostics, recordSkippedRows } from '../sources/parse-diagnostics.js';
import { getParserVersion } from '../sources/parse-fingerprint.js';
import type { SourceAdapter, SourceReadDiagnostics } from '../sources/source-adapter.js';
import { asRecord } from '../utils/as-record.js';
import type { JsonlReadPosition } from '../utils/read-jsonl-objects.js';

/**
 * Where a read of a JSONL file stopped, so the next read can start there. The hash covers
 * every byte before `offset`, so any change to them makes the next read restart.
 */
export type JsonlReadCursor = {
  format: 'jsonl';
  version: 2;
  /** `${source}@${getParserVersion(adapter)}`; a cursor from another parser is invalid. */
  parser: string;
  /** Bytes consumed: the end of the last line-feed-terminated line read. */
  offset: number;
  /** sha256 hex of the first `offset` bytes. */
  prefixHash: string;
  /**
   * Adapter-defined, JSON-serializable parser state at `offset`, for an adapter whose
   * events depend on earlier lines (claude, pi). Treat it as opaque. After a read with
   * `raw: true`, it holds the raw lines of events and tool calls still open at `offset`.
   */
  state?: unknown;
};

/** A cursor any incremental adapter may return. */
export type ReadCursor = JsonlReadCursor;

/**
 * Per kind, how many of the last events the previous read of the file yielded a resumed
 * read replaces: events that depended on how the file ended, such as tool calls still
 * waiting for a result. Unset kinds replace none.
 */
export type ReplacedEventCounts = Partial<Record<EventKind, number>>;

/**
 * Resumes a read of one file. Only an adapter whose `capabilities.incremental` is true
 * honours it; any other adapter ignores it and calls neither callback.
 */
export type ReadResume = {
  /** The cursor a previous read of this file returned. */
  from?: ReadCursor;
  /**
   * Called once when the read of the file starts, before any event. With `restarted`,
   * the read starts from the beginning, so its events replace the earlier ones.
   * Otherwise, drop the last `replaced[kind]` events of each kind you kept from the
   * previous read before keeping this read's events.
   */
  onStart?(info: { restarted: boolean; replaced?: ReplacedEventCounts }): void;
  /**
   * Called once when the read completes, with the cursor to resume from next time. A
   * read that is broken out of or throws does not call it; keep the previous cursor.
   * `partialLine` is true when the file ended in a line without a line feed, which the
   * read left for the next one; a read without `resume` would have parsed it.
   */
  onCursor(update: { cursor: ReadCursor; restarted: boolean; partialLine: boolean }): void;
};

/** The `parser` a cursor records for an adapter. */
export function getCursorParser(adapter: Pick<SourceAdapter, 'id' | 'parserVersion'>): string {
  return `${adapter.id}@${getParserVersion(adapter)}`;
}

/** Whether the value has a JSONL cursor's shape; `validateJsonlCursor` checks the rest. */
export function isJsonlReadCursor(value: unknown): value is JsonlReadCursor {
  const cursor = asRecord(value);

  if (!cursor) {
    return false;
  }

  return (
    cursor.format === 'jsonl' &&
    cursor.version === 2 &&
    typeof cursor.parser === 'string' &&
    typeof cursor.offset === 'number' &&
    Number.isSafeInteger(cursor.offset) &&
    cursor.offset >= 0 &&
    typeof cursor.prefixHash === 'string'
  );
}

const PREFIX_READ_BYTES = 1024 * 1024;

/** A running hash of a file's first `offset` bytes. */
type HashedPrefix = { offset: number; hash: Hash };

/**
 * Checks `cursor` against the file open on `handle`: same parser, a file at least
 * `offset` bytes long, and its first `offset` bytes hashing as recorded. Returns that
 * hash when the cursor is valid, so the resumed read extends it without a second pass.
 */
export async function validateJsonlCursor(
  handle: FileHandle,
  cursor: unknown,
  parser: string,
): Promise<HashedPrefix | undefined> {
  if (!isJsonlReadCursor(cursor) || cursor.parser !== parser) {
    return undefined;
  }

  const { offset } = cursor;

  if ((await handle.stat()).size < offset) {
    return undefined;
  }

  const hash = createHash('sha256');
  const buffer = Buffer.alloc(Math.min(offset, PREFIX_READ_BYTES));
  let hashed = 0;

  while (hashed < offset) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, offset - hashed),
      hashed,
    );

    if (bytesRead === 0) {
      return undefined;
    }

    hash.update(buffer.subarray(0, bytesRead));
    hashed += bytesRead;
  }

  return hash.copy().digest('hex') === cursor.prefixHash ? { offset, hash } : undefined;
}

/**
 * Hashes the bytes a read consumes up to its last complete line while the read runs, so
 * the cursor costs no second pass. A chunk's bytes after that line are copied, since the
 * reader reuses its chunk buffer, and hashed once a later line ends.
 */
class CursorPrefixTracker {
  private readonly hash: Hash;
  // The bytes after `hashedTo` of the chunks read so far: the start of an unfinished line.
  private pending: Buffer[] = [];
  private hashedTo: number;
  // The file offset of the next chunk's first byte.
  private chunkStart: number;
  private lineEnd: number;

  public constructor({ offset, hash }: HashedPrefix) {
    this.hash = hash;
    this.hashedTo = offset;
    this.chunkStart = offset;
    this.lineEnd = offset;
  }

  /** Takes a chunk after its lines were reported, so `lineEnd` already covers them. */
  public addChunk(chunk: Buffer): void {
    // Lines of earlier chunks were hashed with them, so a new line end is in this chunk.
    if (this.lineEnd > this.hashedTo) {
      for (const bytes of this.pending) {
        this.hash.update(bytes);
      }

      this.pending = [];
      this.hash.update(chunk.subarray(0, this.lineEnd - this.chunkStart));
      this.hashedTo = this.lineEnd;
    }

    const chunkEnd = this.chunkStart + chunk.length;

    if (chunkEnd > this.hashedTo) {
      // A chunk inside an unfinished line that began in an earlier chunk is kept whole.
      this.pending.push(Buffer.from(chunk.subarray(Math.max(0, this.hashedTo - this.chunkStart))));
    }

    this.chunkStart = chunkEnd;
  }

  public setLineEnd(lineEndOffset: number): void {
    this.lineEnd = lineEndOffset;
  }

  /** Whether the bytes read go past the last complete line. */
  public hasPartialLine(): boolean {
    return this.chunkStart > this.lineEnd;
  }

  public toCursor(parser: string, state: unknown): JsonlReadCursor {
    return {
      format: 'jsonl',
      version: 2,
      parser,
      offset: this.hashedTo,
      prefixHash: this.hash.copy().digest('hex'),
      ...(state !== undefined && { state }),
    };
  }

  public position(handle: FileHandle): JsonlReadPosition {
    return {
      handle,
      start: this.lineEnd,
      onChunk: (chunk) => {
        this.addChunk(chunk);
      },
      onLineEnd: (lineEndOffset) => {
        this.setLineEnd(lineEndOffset);
      },
    };
  }
}

function startTracker(): CursorPrefixTracker {
  return new CursorPrefixTracker({ offset: 0, hash: createHash('sha256') });
}

/**
 * Runs a JSONL read under `resume`: validates `resume.from` on a handle it opens, starts
 * the read at the cursor or at 0, and reports the cursor once `read` completes. `read`
 * passes the position to `readJsonlObjects` or `readClassifiedJsonlObjects`. For an
 * adapter whose lines parse on their own; see `readJsonlFromStatefulCursor` otherwise.
 */
export async function* readJsonlFromCursor<T>(
  adapter: Pick<SourceAdapter, 'id' | 'parserVersion'>,
  filePath: string,
  resume: ReadResume,
  read: (position: JsonlReadPosition) => AsyncIterable<T>,
): AsyncGenerator<T, void, undefined> {
  const parser = getCursorParser(adapter);
  const handle = await open(filePath, 'r');

  try {
    const prefix = await validateJsonlCursor(handle, resume.from, parser);
    const restarted = prefix === undefined;
    const tracker = prefix ? new CursorPrefixTracker(prefix) : startTracker();

    resume.onStart?.({ restarted });
    yield* read(tracker.position(handle));
    resume.onCursor({
      cursor: tracker.toCursor(parser, undefined),
      restarted,
      partialLine: tracker.hasPartialLine(),
    });
  } finally {
    await handle.close();
  }
}

/**
 * Thrown by a resumed pass that cannot continue exactly from the cursor's state, for
 * example when an appended line repeats an id the state keeps only as a hash. The read
 * then restarts from byte 0.
 */
export class ResumeConflict extends Error {
  public constructor() {
    super('The read cannot resume from this cursor');
    this.name = 'ResumeConflict';
  }
}

/** One pass of a stateful adapter's parse, from byte 0 or from a cursor's state. */
export type ResumablePass<State> = {
  position: JsonlReadPosition;
  /** The state to resume from; unset for a pass from byte 0. */
  from?: State;
  /**
   * Called once the pass is done, with the state to store in the next cursor, or
   * undefined when the next read cannot resume from where this one ended and must restart.
   */
  end: (state: State | undefined) => void;
};

/** How a stateful adapter starts and resumes a read. */
export type StatefulJsonlReader<T, State extends { replaced: ReplacedEventCounts }> = {
  /**
   * Checks a cursor's state; undefined restarts the read. `replaced` is what the resumed
   * pass replaces of the previous read's events.
   */
  parseState(value: unknown): State | undefined;
  /** A pass that records skipped rows in `diagnostics`. A resumed pass may throw `ResumeConflict`. */
  parse(pass: ResumablePass<State>, diagnostics: SourceReadDiagnostics): AsyncIterable<T>;
};

type StatefulJsonlPass<T> = { events: AsyncIterable<T>; state: () => unknown };

function startPass<T, State extends { replaced: ReplacedEventCounts }>(
  reader: StatefulJsonlReader<T, State>,
  position: JsonlReadPosition,
  diagnostics: SourceReadDiagnostics,
  from?: State,
): StatefulJsonlPass<T> {
  let endState: State | undefined;
  const events = reader.parse(
    {
      position,
      from,
      end: (state) => {
        endState = state;
      },
    },
    diagnostics,
  );

  return { events, state: () => endState };
}

/**
 * `readJsonlFromCursor` for an adapter whose events depend on earlier lines. The cursor
 * carries the adapter's state. A resumed pass runs to the end before anything is yielded
 * or counted, so a pass that throws `ResumeConflict` leaves no trace and the read
 * restarts from byte 0, as it does for an invalid cursor or state.
 */
export async function* readJsonlFromStatefulCursor<
  T,
  State extends { replaced: ReplacedEventCounts },
>(
  adapter: Pick<SourceAdapter, 'id' | 'parserVersion'>,
  filePath: string,
  resume: ReadResume,
  diagnostics: SourceReadDiagnostics,
  reader: StatefulJsonlReader<T, State>,
): AsyncGenerator<T, void, undefined> {
  const parser = getCursorParser(adapter);
  const handle = await open(filePath, 'r');

  try {
    const prefix = await validateJsonlCursor(handle, resume.from, parser);
    const from = prefix ? reader.parseState(resume.from?.state) : undefined;

    if (prefix && from) {
      const tracker = new CursorPrefixTracker(prefix);
      const passDiagnostics = createReadDiagnostics();
      const pass = startPass(reader, tracker.position(handle), passDiagnostics, from);
      const events = await collectUnlessConflict(pass.events);

      if (events) {
        recordSkippedRows(diagnostics, passDiagnostics);
        resume.onStart?.({ restarted: false, replaced: from.replaced });
        yield* events;
        resume.onCursor({
          cursor: tracker.toCursor(parser, pass.state()),
          restarted: false,
          partialLine: tracker.hasPartialLine(),
        });
        return;
      }
    }

    const tracker = startTracker();
    const pass = startPass(reader, tracker.position(handle), diagnostics);

    resume.onStart?.({ restarted: true });
    yield* pass.events;
    resume.onCursor({
      cursor: tracker.toCursor(parser, pass.state()),
      restarted: true,
      partialLine: tracker.hasPartialLine(),
    });
  } finally {
    await handle.close();
  }
}

async function collectUnlessConflict<T>(events: AsyncIterable<T>): Promise<T[] | undefined> {
  const collected: T[] = [];

  try {
    for await (const event of events) {
      collected.push(event);
    }
  } catch (error) {
    if (error instanceof ResumeConflict) {
      return undefined;
    }

    throw error;
  }

  return collected;
}
