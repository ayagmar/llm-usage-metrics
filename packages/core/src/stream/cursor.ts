import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

import type { EventKind } from '../domain/session-event.js';
import { createReadDiagnostics, recordSkippedRows } from '../sources/parse-diagnostics.js';
import { getParserVersion } from '../sources/parse-fingerprint.js';
import type { SourceAdapter, SourceReadDiagnostics } from '../sources/source-adapter.js';
import { asRecord } from '../utils/as-record.js';
import type { JsonlReadPosition } from '../utils/read-jsonl-objects.js';

/**
 * Where a read of a JSONL file stopped, so the next read can start there. Stores are
 * assumed append-only: the hashes cover the first and last 64 KiB before `offset`, so a
 * rewrite that keeps the size and changes only bytes between those windows still passes.
 */
export type JsonlReadCursor = {
  format: 'jsonl';
  version: 1;
  /** `${source}@${getParserVersion(adapter)}`; a cursor from another parser is invalid. */
  parser: string;
  /** Bytes consumed: the end of the last line-feed-terminated line read. */
  offset: number;
  /** sha256 hex of the first `min(offset, 64 KiB)` bytes. */
  headHash: string;
  /** sha256 hex of the `min(offset, 64 KiB)` bytes ending at `offset`. */
  tailHash: string;
  /**
   * Adapter-defined, JSON-serializable parser state at `offset`, for an adapter whose
   * events depend on earlier lines (claude, pi). Treat it as opaque.
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

/** The size of the head and tail windows a cursor hashes. */
export const CURSOR_HASH_WINDOW_BYTES = 64 * 1024;

/** The `parser` a cursor records for an adapter. */
export function getCursorParser(adapter: Pick<SourceAdapter, 'id' | 'parserVersion'>): string {
  return `${adapter.id}@${getParserVersion(adapter)}`;
}

export function hashCursorWindow(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

type CursorWindows = { offset: number; head: Buffer; tail: Buffer };

/** Whether the value has a JSONL cursor's shape; `validateJsonlCursor` checks the rest. */
export function isJsonlReadCursor(value: unknown): value is JsonlReadCursor {
  const cursor = asRecord(value);

  if (!cursor) {
    return false;
  }

  return (
    cursor.format === 'jsonl' &&
    cursor.version === 1 &&
    typeof cursor.parser === 'string' &&
    typeof cursor.offset === 'number' &&
    Number.isSafeInteger(cursor.offset) &&
    cursor.offset >= 0 &&
    typeof cursor.headHash === 'string' &&
    typeof cursor.tailHash === 'string'
  );
}

async function readWindow(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;

  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);

    if (bytesRead === 0) {
      return buffer.subarray(0, filled);
    }

    filled += bytesRead;
  }

  return buffer;
}

/**
 * Checks `cursor` against the file open on `handle`: same parser, a file at least
 * `offset` bytes long, and both windows hashing as recorded. Returns the windows it read
 * when the cursor is valid, so the resumed read can extend them without reading again.
 */
export async function validateJsonlCursor(
  handle: FileHandle,
  cursor: unknown,
  parser: string,
): Promise<CursorWindows | undefined> {
  if (!isJsonlReadCursor(cursor) || cursor.parser !== parser) {
    return undefined;
  }

  const { offset } = cursor;

  if ((await handle.stat()).size < offset) {
    return undefined;
  }

  const windowLength = Math.min(offset, CURSOR_HASH_WINDOW_BYTES);
  const head = await readWindow(handle, 0, windowLength);

  if (head.length < windowLength || hashCursorWindow(head) !== cursor.headHash) {
    return undefined;
  }

  const tail =
    offset === windowLength ? head : await readWindow(handle, offset - windowLength, windowLength);

  if (tail.length < windowLength || hashCursorWindow(tail) !== cursor.tailHash) {
    return undefined;
  }

  return { offset, head, tail };
}

/**
 * Keeps the bytes a cursor hashes while a read consumes the file: the head up to 64 KiB
 * and the bytes from 64 KiB before the last complete line onward, copied out of each
 * chunk once its lines are reported, since the reader reuses its chunk buffer.
 */
class CursorWindowTracker {
  private readonly headChunks: Buffer[] = [];
  private headLength: number;
  private readonly tailChunks: Buffer[] = [];
  // The file offset of tailChunks[0]'s first byte.
  private tailStart: number;
  // The file offset of the next chunk's first byte.
  private chunkStart: number;
  private lineEnd: number;

  public constructor(windows: CursorWindows) {
    this.headChunks.push(windows.head);
    this.headLength = windows.head.length;
    this.tailChunks.push(windows.tail);
    this.tailStart = windows.offset - windows.tail.length;
    this.chunkStart = windows.offset;
    this.lineEnd = windows.offset;
  }

  /** Takes a chunk after its lines were reported, so `lineEnd` already covers them. */
  public addChunk(chunk: Buffer): void {
    if (this.headLength < CURSOR_HASH_WINDOW_BYTES) {
      const headPart = chunk.subarray(0, CURSOR_HASH_WINDOW_BYTES - this.headLength);
      this.headChunks.push(Buffer.from(headPart));
      this.headLength += headPart.length;
    }

    // A later window ends at or after lineEnd, so it never needs a byte before this.
    const windowStart = this.lineEnd - CURSOR_HASH_WINDOW_BYTES;
    const keepFrom = Math.max(this.chunkStart, windowStart);

    if (keepFrom > this.chunkStart) {
      this.tailChunks.length = 0;
      this.tailStart = keepFrom;
    }

    this.tailChunks.push(Buffer.from(chunk.subarray(keepFrom - this.chunkStart)));
    this.chunkStart += chunk.length;

    while (
      this.tailChunks.length > 1 &&
      this.tailStart + this.tailChunks[0].length <= windowStart
    ) {
      this.tailStart += this.tailChunks[0].length;
      this.tailChunks.shift();
    }
  }

  public setLineEnd(lineEndOffset: number): void {
    this.lineEnd = lineEndOffset;
  }

  /** Whether the bytes read go past the last complete line. */
  public hasPartialLine(): boolean {
    return this.chunkStart > this.lineEnd;
  }

  public toCursor(parser: string, state: unknown): JsonlReadCursor {
    const offset = this.lineEnd;
    const windowLength = Math.min(offset, CURSOR_HASH_WINDOW_BYTES);
    const windowStart = offset - windowLength - this.tailStart;
    const head = Buffer.concat(this.headChunks).subarray(0, windowLength);
    const tail = Buffer.concat(this.tailChunks).subarray(windowStart, windowStart + windowLength);

    return {
      format: 'jsonl',
      version: 1,
      parser,
      offset,
      headHash: hashCursorWindow(head),
      tailHash: hashCursorWindow(tail),
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

const EMPTY_WINDOWS: CursorWindows = { offset: 0, head: Buffer.alloc(0), tail: Buffer.alloc(0) };

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
    const validWindows = await validateJsonlCursor(handle, resume.from, parser);
    const restarted = validWindows === undefined;
    const tracker = new CursorWindowTracker(validWindows ?? EMPTY_WINDOWS);

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

/** One pass of a stateful read over a file, from byte 0 or from a cursor. */
export type StatefulJsonlPass<T> = {
  events: AsyncIterable<T>;
  /**
   * Once `events` is done: the state to store in the next cursor, or undefined when the
   * next read cannot resume from where this one ended and must restart.
   */
  state(): unknown;
};

/** How a stateful adapter starts and resumes a read. */
export type StatefulJsonlReader<T> = {
  /** A pass from byte 0 that records skipped rows in `diagnostics`. */
  start(position: JsonlReadPosition, diagnostics: SourceReadDiagnostics): StatefulJsonlPass<T>;
  /**
   * Checks a cursor's state. Undefined restarts the read. Otherwise `replaced` is what the
   * resumed pass replaces of the previous read's events, and `resume` starts that pass
   * from the state. The pass may throw `ResumeConflict`.
   */
  restore(state: unknown):
    | {
        replaced: ReplacedEventCounts;
        resume: (
          position: JsonlReadPosition,
          diagnostics: SourceReadDiagnostics,
        ) => StatefulJsonlPass<T>;
      }
    | undefined;
};

/**
 * `readJsonlFromCursor` for an adapter whose events depend on earlier lines. The cursor
 * carries the adapter's state. A resumed pass runs to the end before anything is yielded
 * or counted, so a pass that throws `ResumeConflict` leaves no trace and the read
 * restarts from byte 0, as it does for an invalid cursor or state.
 */
export async function* readJsonlFromStatefulCursor<T>(
  adapter: Pick<SourceAdapter, 'id' | 'parserVersion'>,
  filePath: string,
  resume: ReadResume,
  diagnostics: SourceReadDiagnostics,
  reader: StatefulJsonlReader<T>,
): AsyncGenerator<T, void, undefined> {
  const parser = getCursorParser(adapter);
  const handle = await open(filePath, 'r');

  try {
    const validWindows = await validateJsonlCursor(handle, resume.from, parser);
    const restored = validWindows ? reader.restore(resume.from?.state) : undefined;

    if (validWindows && restored) {
      const tracker = new CursorWindowTracker(validWindows);
      const passDiagnostics = createReadDiagnostics();
      const pass = restored.resume(tracker.position(handle), passDiagnostics);
      const events = await collectUnlessConflict(pass.events);

      if (events) {
        recordSkippedRows(diagnostics, passDiagnostics);
        resume.onStart?.({ restarted: false, replaced: restored.replaced });
        yield* events;
        resume.onCursor({
          cursor: tracker.toCursor(parser, pass.state()),
          restarted: false,
          partialLine: tracker.hasPartialLine(),
        });
        return;
      }
    }

    const tracker = new CursorWindowTracker(EMPTY_WINDOWS);
    const pass = reader.start(tracker.position(handle), diagnostics);

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
