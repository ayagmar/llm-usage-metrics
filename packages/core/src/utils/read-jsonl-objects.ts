import { createReadStream } from 'node:fs';

import { asRecord } from './as-record.js';

type ReadJsonlObjectsOptions = {
  onMalformedLine?: () => void;
  shouldParseLine?: (lineText: string) => boolean;
  shouldParseLineBytes?: (lineBytes: Buffer) => boolean;
};

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const STREAM_CHUNK_SIZE_BYTES = 1024 * 1024;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

export async function* readJsonlObjects(
  filePath: string,
  options: ReadJsonlObjectsOptions = {},
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
    stream.destroy();
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
  options: ReadJsonlObjectsOptions,
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
    options.onMalformedLine?.();
    return undefined;
  }

  return asRecord(parsed) ?? undefined;
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
