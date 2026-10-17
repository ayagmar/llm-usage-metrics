import { createReadStream, type ReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import { asRecord } from './as-record.js';

/**
 * A read that starts at a byte offset and reports where each complete line ends, for a
 * resumable read. Under a position, a final line without a line feed is neither parsed
 * nor reported: it is read whole once its line feed arrives.
 */
export type JsonlReadPosition = {
  /**
   * An open handle to read from. The read never closes it, even when the consumer stops
   * early, so its owner can still use it and must close it.
   */
  handle: FileHandle;
  /** The byte offset to start at. A BOM is stripped only when it is 0. */
  start: number;
  /** Every chunk read, in order, starting at `start`. */
  onChunk: (chunk: Buffer) => void;
  /** The offset just past each complete line's line feed, before its record is yielded. */
  onLineEnd: (lineEndOffset: number) => void;
};

// A line predicate sees either the line's bytes or its trimmed text; the malformed-line
// callback and the usage classifier receive the same input as the predicate.
type BytesLineOptions = {
  shouldParseLineBytes: (lineBytes: Buffer) => boolean;
  shouldParseLine?: never;
  onMalformedLine?: (lineBytes: Buffer) => void;
  position?: JsonlReadPosition;
};

type TextLineOptions = {
  shouldParseLineBytes?: never;
  shouldParseLine?: (lineText: string) => boolean;
  onMalformedLine?: (lineText: string) => void;
  position?: JsonlReadPosition;
};

export type ReadJsonlObjectsOptions = BytesLineOptions | TextLineOptions;

/** Classifies each parsed line by whether the usage prefilter accepts it. */
export type ReadClassifiedJsonlObjectsOptions =
  | (BytesLineOptions & { isUsageLineBytes: (lineBytes: Buffer) => boolean })
  | (TextLineOptions & { isUsageLine: (lineText: string) => boolean });

export type ClassifiedJsonlObject = {
  record: Record<string, unknown>;
  /** Whether the usage prefilter accepted the line, so the usage branch may read it. */
  isUsageLine: boolean;
};

// Builds a batch item from a parsed record and the line it came from.
type ToItem<T> = (record: Record<string, unknown>, lineBytes: Buffer, lineText: string) => T;

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const STREAM_CHUNK_SIZE_BYTES = 1024 * 1024;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

// Overloads, so each form's callbacks are typed from the predicate the caller passes.
export function readJsonlObjects(
  filePath: string,
  options: BytesLineOptions,
): AsyncGenerator<Record<string, unknown>, void, undefined>;
export function readJsonlObjects(
  filePath: string,
  options?: TextLineOptions,
): AsyncGenerator<Record<string, unknown>, void, undefined>;
export function readJsonlObjects(
  filePath: string,
  options: ReadJsonlObjectsOptions = {},
): AsyncGenerator<Record<string, unknown>, void, undefined> {
  return flattenBatches(readJsonlBatches(filePath, options, toRecord));
}

/**
 * `readJsonlObjects` in batches: one array per chunk read, holding that chunk's records in
 * file order, so a consumer awaits once per chunk instead of once per record. The line
 * callbacks run as each chunk is split, before its batch is yielded, so a consumer that
 * stops early may have seen them called for lines after the record it stopped at.
 */
export function readJsonlObjectBatches(
  filePath: string,
  options: BytesLineOptions,
): AsyncGenerator<Record<string, unknown>[], void, undefined>;
export function readJsonlObjectBatches(
  filePath: string,
  options?: TextLineOptions,
): AsyncGenerator<Record<string, unknown>[], void, undefined>;
export function readJsonlObjectBatches(
  filePath: string,
  options: ReadJsonlObjectsOptions = {},
): AsyncGenerator<Record<string, unknown>[], void, undefined> {
  return readJsonlBatches(filePath, options, toRecord);
}

/**
 * `readJsonlObjects` that also reports, per object, whether the usage prefilter accepted
 * its line. The line predicate is the union prefilter of every kind the read wants.
 */
export function readClassifiedJsonlObjects(
  filePath: string,
  options: BytesLineOptions & { isUsageLineBytes: (lineBytes: Buffer) => boolean },
): AsyncGenerator<ClassifiedJsonlObject, void, undefined>;
export function readClassifiedJsonlObjects(
  filePath: string,
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- a union leaves the callbacks untyped
  options: TextLineOptions & { isUsageLine: (lineText: string) => boolean },
): AsyncGenerator<ClassifiedJsonlObject, void, undefined>;
export function readClassifiedJsonlObjects(
  filePath: string,
  options: ReadClassifiedJsonlObjectsOptions,
): AsyncGenerator<ClassifiedJsonlObject, void, undefined> {
  return flattenBatches(readJsonlBatches(filePath, options, toClassifiedItem(options)));
}

/** `readClassifiedJsonlObjects` in batches, as `readJsonlObjectBatches` batches records. */
export function readClassifiedJsonlObjectBatches(
  filePath: string,
  options: BytesLineOptions & { isUsageLineBytes: (lineBytes: Buffer) => boolean },
): AsyncGenerator<ClassifiedJsonlObject[], void, undefined>;
export function readClassifiedJsonlObjectBatches(
  filePath: string,
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- a union leaves the callbacks untyped
  options: TextLineOptions & { isUsageLine: (lineText: string) => boolean },
): AsyncGenerator<ClassifiedJsonlObject[], void, undefined>;
export function readClassifiedJsonlObjectBatches(
  filePath: string,
  options: ReadClassifiedJsonlObjectsOptions,
): AsyncGenerator<ClassifiedJsonlObject[], void, undefined> {
  return readJsonlBatches(filePath, options, toClassifiedItem(options));
}

const toRecord: ToItem<Record<string, unknown>> = (record) => record;

function toClassifiedItem(
  options: ReadClassifiedJsonlObjectsOptions,
): ToItem<ClassifiedJsonlObject> {
  return 'isUsageLineBytes' in options
    ? (record, lineBytes) => ({ record, isUsageLine: options.isUsageLineBytes(lineBytes) })
    : (record, _lineBytes, lineText) => ({ record, isUsageLine: options.isUsageLine(lineText) });
}

async function* flattenBatches<T>(
  batches: AsyncGenerator<T[], void, undefined>,
): AsyncGenerator<T, void, undefined> {
  for await (const batch of batches) {
    yield* batch;
  }
}

// Reads through the caller's handle with positioned reads, so nothing here owns or closes
// it: destroying a stream made by `handle.createReadStream` closes the handle.
async function* readHandleChunks(handle: FileHandle, start: number): AsyncGenerator<Buffer> {
  let offset = start;

  for (;;) {
    const buffer = Buffer.allocUnsafe(STREAM_CHUNK_SIZE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);

    if (bytesRead === 0) {
      return;
    }

    offset += bytesRead;
    // A short read keeps only its bytes, so a held chunk does not pin the whole buffer.
    yield bytesRead === buffer.length ? buffer : Buffer.from(buffer.subarray(0, bytesRead));
  }
}

async function* readJsonlBatches<T>(
  filePath: string,
  options: ReadJsonlObjectsOptions,
  toItem: ToItem<T>,
): AsyncGenerator<T[], void, undefined> {
  const { position } = options;
  let stream: ReadStream | undefined;
  let chunks: AsyncIterable<Buffer>;

  if (position) {
    chunks = readHandleChunks(position.handle, position.start);
  } else {
    stream = createReadStream(filePath, { highWaterMark: STREAM_CHUNK_SIZE_BYTES });
    chunks = stream as AsyncIterable<Buffer>;
  }

  let isFirstLine = !position || position.start === 0;
  let carriedChunks: Buffer[] = [];
  let chunkOffset = position?.start ?? 0;

  try {
    for await (const chunk of chunks) {
      const batch: T[] = [];
      let lineStart = 0;
      position?.onChunk(chunk);

      while (lineStart < chunk.length) {
        const lineEnd = chunk.indexOf(LINE_FEED, lineStart);

        if (lineEnd === -1) {
          break;
        }

        const lineBytes = takeLineBytes(chunk.subarray(lineStart, lineEnd), carriedChunks);
        carriedChunks = [];
        lineStart = lineEnd + 1;

        const item = parseJsonlLine(lineBytes, isFirstLine, options, toItem);
        isFirstLine = false;

        if (position) {
          position.onLineEnd(chunkOffset + lineStart);
        }

        if (item !== undefined) {
          batch.push(item);
        }
      }

      if (lineStart < chunk.length) {
        carriedChunks.push(chunk.subarray(lineStart));
      }

      chunkOffset += chunk.length;

      if (batch.length > 0) {
        yield batch;
      }
    }

    // A resumable read leaves an unterminated final line for the read after its line feed.
    if (carriedChunks.length > 0 && !position) {
      const lineBytes = takeLineBytes(Buffer.alloc(0), carriedChunks);
      const item = parseJsonlLine(lineBytes, isFirstLine, options, toItem);

      if (item !== undefined) {
        yield [item];
      }
    }
  } finally {
    // Wait for the fd to close, so breaking out of a read leaves no file open.
    if (stream && !stream.closed) {
      const closed = new Promise((resolve) => stream.once('close', resolve));
      stream.destroy();
      await closed;
    }
  }
}

function takeLineBytes(lineEndBytes: Buffer, carriedChunks: Buffer[]): Buffer {
  if (carriedChunks.length === 0) {
    return lineEndBytes;
  }

  return Buffer.concat([...carriedChunks, lineEndBytes]);
}

function parseJsonlLine<T>(
  lineBytes: Buffer,
  isFirstLine: boolean,
  options: ReadJsonlObjectsOptions,
  toItem: ToItem<T>,
): T | undefined {
  let lineStart = 0;
  let lineEnd = lineBytes.length;

  if (lineEnd > 0 && lineBytes[lineEnd - 1] === CARRIAGE_RETURN) {
    lineEnd -= 1;
  }

  if (isFirstLine && hasUtf8Bom(lineBytes, lineStart, lineEnd)) {
    lineStart += UTF8_BOM.length;
  }

  if (isBlankLine(lineBytes, lineStart, lineEnd)) {
    return undefined;
  }

  const parseLineBytes = lineBytes.subarray(lineStart, lineEnd);

  if (options.shouldParseLineBytes && !options.shouldParseLineBytes(parseLineBytes)) {
    return undefined;
  }

  const lineText = lineBytes.toString('utf8', lineStart, lineEnd).trim();

  if (!lineText) {
    return undefined;
  }

  if (options.shouldParseLine && !options.shouldParseLine(lineText)) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(lineText);
  } catch {
    if (options.shouldParseLineBytes) {
      options.onMalformedLine?.(parseLineBytes);
    } else {
      options.onMalformedLine?.(lineText);
    }

    return undefined;
  }

  const record = asRecord(parsed);

  return record ? toItem(record, parseLineBytes, lineText) : undefined;
}

function hasUtf8Bom(lineBytes: Buffer, lineStart: number, lineEnd: number): boolean {
  return (
    lineEnd - lineStart >= UTF8_BOM.length &&
    lineBytes[lineStart] === UTF8_BOM[0] &&
    lineBytes[lineStart + 1] === UTF8_BOM[1] &&
    lineBytes[lineStart + 2] === UTF8_BOM[2]
  );
}

function isBlankLine(lineBytes: Buffer, lineStart: number, lineEnd: number): boolean {
  for (let index = lineStart; index < lineEnd; index += 1) {
    if (lineBytes[index] > 0x20) {
      return false;
    }
  }

  return true;
}
