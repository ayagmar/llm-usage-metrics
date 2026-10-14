import { createReadStream } from 'node:fs';

import { asRecord } from './as-record.js';

// A line predicate sees either the line's bytes or its trimmed text; the malformed-line
// callback and the usage classifier receive the same input as the predicate.
type BytesLineOptions = {
  shouldParseLineBytes: (lineBytes: Buffer) => boolean;
  shouldParseLine?: never;
  onMalformedLine?: (lineBytes: Buffer) => void;
};

type TextLineOptions = {
  shouldParseLineBytes?: never;
  shouldParseLine?: (lineText: string) => boolean;
  onMalformedLine?: (lineText: string) => void;
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

// A classified read is told each record's line before the record is yielded.
type LineReader = ReadJsonlObjectsOptions & {
  onRecordLine?: (lineBytes: Buffer, lineText: string) => void;
};

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
  return readJsonlItems(filePath, options);
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
  const isUsageLineInput: (lineBytes: Buffer, lineText: string) => boolean =
    'isUsageLineBytes' in options
      ? (lineBytes) => options.isUsageLineBytes(lineBytes)
      : (_lineBytes, lineText) => options.isUsageLine(lineText);

  return classifyJsonlObjects(filePath, options, isUsageLineInput);
}

async function* classifyJsonlObjects(
  filePath: string,
  options: ReadJsonlObjectsOptions,
  isUsageLineInput: (lineBytes: Buffer, lineText: string) => boolean,
): AsyncGenerator<ClassifiedJsonlObject, void, undefined> {
  let isUsageLine = false;
  const records = readJsonlItems(filePath, {
    ...options,
    onRecordLine: (lineBytes, lineText) => {
      isUsageLine = isUsageLineInput(lineBytes, lineText);
    },
  });

  // Each record is yielded right after its line is classified.
  for await (const record of records) {
    yield { record, isUsageLine };
  }
}

async function* readJsonlItems(
  filePath: string,
  options: LineReader,
): AsyncGenerator<Record<string, unknown>, void, undefined> {
  const stream = createReadStream(filePath, {
    highWaterMark: STREAM_CHUNK_SIZE_BYTES,
  });

  let isFirstLine = true;
  let carriedChunks: Buffer[] = [];

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let lineStart = 0;

      while (lineStart < chunk.length) {
        const lineEnd = chunk.indexOf(LINE_FEED, lineStart);

        if (lineEnd === -1) {
          break;
        }

        const lineBytes = takeLineBytes(chunk.subarray(lineStart, lineEnd), carriedChunks);
        carriedChunks = [];
        lineStart = lineEnd + 1;

        const parsedObject = parseJsonlLine(lineBytes, isFirstLine, options);
        isFirstLine = false;

        if (parsedObject) {
          yield parsedObject;
        }
      }

      if (lineStart < chunk.length) {
        carriedChunks.push(chunk.subarray(lineStart));
      }
    }

    if (carriedChunks.length > 0) {
      const lineBytes = takeLineBytes(Buffer.alloc(0), carriedChunks);
      const parsedObject = parseJsonlLine(lineBytes, isFirstLine, options);

      if (parsedObject) {
        yield parsedObject;
      }
    }
  } finally {
    // Wait for the fd to close, so breaking out of a read leaves no file open.
    if (!stream.closed) {
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

function parseJsonlLine(
  lineBytes: Buffer,
  isFirstLine: boolean,
  options: LineReader,
): Record<string, unknown> | undefined {
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

  if (record && options.onRecordLine) {
    options.onRecordLine(parseLineBytes, lineText);
  }

  return record ?? undefined;
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
