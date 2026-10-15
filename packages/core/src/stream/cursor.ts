import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

import { getParserVersion } from '../sources/parse-fingerprint.js';
import type { SourceAdapter } from '../sources/source-adapter.js';
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
  /** Reserved for adapter-defined, JSON-serializable state. Unused for now. */
  state?: unknown;
};

/** A cursor any incremental adapter may return. */
export type ReadCursor = JsonlReadCursor;

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
   */
  onStart?(info: { restarted: boolean }): void;
  /**
   * Called once when the read completes, with the cursor to resume from next time. A
   * read that is broken out of or throws does not call it; keep the previous cursor.
   */
  onCursor(update: { cursor: ReadCursor; restarted: boolean }): void;
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

function isJsonlReadCursor(value: unknown): value is JsonlReadCursor {
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
 * and a rolling window ending at the last complete line. Bytes past that line stay held
 * until the window passes them, as the line reader holds them.
 */
class CursorWindowTracker {
  private readonly headChunks: Buffer[] = [];
  private headLength: number;
  private readonly tailChunks: Buffer[] = [];
  // The file offset of tailChunks[0]'s first byte.
  private tailStart: number;
  private lineEnd: number;

  public constructor(windows: CursorWindows) {
    this.headChunks.push(windows.head);
    this.headLength = windows.head.length;
    this.tailChunks.push(windows.tail);
    this.tailStart = windows.offset - windows.tail.length;
    this.lineEnd = windows.offset;
  }

  public addChunk(chunk: Buffer): void {
    if (this.headLength < CURSOR_HASH_WINDOW_BYTES) {
      const headPart = chunk.subarray(0, CURSOR_HASH_WINDOW_BYTES - this.headLength);
      this.headChunks.push(Buffer.from(headPart));
      this.headLength += headPart.length;
    }

    this.tailChunks.push(chunk);
    this.dropBytesBeforeWindow();
  }

  public setLineEnd(lineEndOffset: number): void {
    this.lineEnd = lineEndOffset;
  }

  public toCursor(parser: string): JsonlReadCursor {
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
    };
  }

  private dropBytesBeforeWindow(): void {
    const windowStart = this.lineEnd - CURSOR_HASH_WINDOW_BYTES;

    while (
      this.tailChunks.length > 1 &&
      this.tailStart + this.tailChunks[0].length <= windowStart
    ) {
      this.tailStart += this.tailChunks[0].length;
      this.tailChunks.shift();
    }
  }
}

const EMPTY_WINDOWS: CursorWindows = { offset: 0, head: Buffer.alloc(0), tail: Buffer.alloc(0) };

/**
 * Runs a JSONL read under `resume`: validates `resume.from` on a handle it opens, starts
 * the read at the cursor or at 0, and reports the cursor once `read` completes. `read`
 * passes the position to `readJsonlObjects` or `readClassifiedJsonlObjects`.
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

    yield* read({
      handle,
      start: validWindows?.offset ?? 0,
      onChunk: (chunk) => {
        tracker.addChunk(chunk);
      },
      onLineEnd: (lineEndOffset) => {
        tracker.setLineEnd(lineEndOffset);
      },
    });

    resume.onCursor({ cursor: tracker.toCursor(parser), restarted });
  } finally {
    await handle.close();
  }
}
