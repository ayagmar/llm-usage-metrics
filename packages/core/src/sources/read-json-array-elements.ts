import { stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

import { DEFAULT_CHUNK_SIZE_BYTES, readFileChunks } from '../utils/read-file-chunks.js';
import { MAX_JSON_TRANSCRIPT_BYTES, readJsonTranscriptFile } from './read-json-file.js';

const SPACE = 0x20;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

export type ReadJsonArrayElementsOptions = {
  /** Thrown when the file is readable JSON but not an array. */
  notArrayMessage: string;
  chunkSize?: number;
};

/** JSON whitespace only; `JSON.parse` skips nothing else (no BOM, NBSP or U+2028). */
function isJsonWhitespace(code: number): boolean {
  return code === SPACE || code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN;
}

type ScanPhase = 'before-array' | 'before-element' | 'after-comma' | 'after-element' | 'done';

/**
 * Splits a top-level JSON array into its elements' text, tracking strings, escapes and
 * nesting. Each element is checked by `JSON.parse`; the structure between elements is
 * checked here, so a document is accepted exactly when `JSON.parse` would accept it whole.
 */
class JsonArrayScanner {
  private phase: ScanPhase = 'before-array';
  private inElement = false;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private elementParts: string[] = [];

  public *feed(text: string): Generator<unknown, void, undefined> {
    let elementStart = this.inElement ? 0 : -1;

    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);

      if (this.inElement) {
        if (this.inString) {
          if (this.escaped) {
            this.escaped = false;
          } else if (code === BACKSLASH) {
            this.escaped = true;
          } else if (code === QUOTE) {
            this.inString = false;
          }
          continue;
        }

        if (code === QUOTE) {
          this.inString = true;
          continue;
        }

        if (code === OPEN_BRACKET || code === OPEN_BRACE) {
          this.depth += 1;
          continue;
        }

        if (this.depth > 0) {
          if (code === CLOSE_BRACKET || code === CLOSE_BRACE) {
            this.depth -= 1;
          }
          continue;
        }

        if (code !== COMMA && code !== CLOSE_BRACKET && !isJsonWhitespace(code)) {
          continue;
        }

        this.elementParts.push(text.slice(elementStart, index));
        yield this.takeElement();
        elementStart = -1;
        this.phase = 'after-element';
      }

      if (isJsonWhitespace(code)) {
        continue;
      }

      if (this.phase === 'before-array') {
        this.expect(code === OPEN_BRACKET);
        this.phase = 'before-element';
      } else if (this.phase === 'after-element') {
        this.expect(code === COMMA || code === CLOSE_BRACKET);
        this.phase = code === COMMA ? 'after-comma' : 'done';
      } else if (this.phase === 'before-element' && code === CLOSE_BRACKET) {
        this.phase = 'done';
      } else {
        this.expect(this.phase !== 'done' && code !== COMMA && code !== CLOSE_BRACKET);
        // Rescan this character as the element's first.
        this.inElement = true;
        elementStart = index;
        index -= 1;
      }
    }

    if (this.inElement) {
      this.elementParts.push(text.slice(elementStart));
    }
  }

  public finish(): void {
    this.expect(this.phase === 'done' && !this.inElement);
  }

  private takeElement(): unknown {
    const elementText = this.elementParts.join('');
    this.elementParts = [];
    this.inElement = false;
    return JSON.parse(elementText) as unknown;
  }

  private expect(condition: boolean): void {
    if (!condition) {
      throw new SyntaxError('Unexpected token in JSON array');
    }
  }
}

/**
 * Yields an array document's elements, or returns `false` before reading past the first
 * byte that is not JSON whitespace when it is not `[`.
 */
async function* streamArrayElements(
  filePath: string,
  chunkSize: number,
): AsyncGenerator<unknown, boolean, undefined> {
  const decoder = new StringDecoder('utf8');
  const scanner = new JsonArrayScanner();
  let routed = false;

  for await (const chunk of readFileChunks(filePath, chunkSize)) {
    if (!routed) {
      const firstByte = chunk.find((byte) => !isJsonWhitespace(byte));

      if (firstByte !== undefined) {
        if (firstByte !== OPEN_BRACKET) {
          return false;
        }

        routed = true;
      }
    }

    yield* scanner.feed(decoder.write(chunk));
  }

  if (!routed) {
    return false;
  }

  yield* scanner.feed(decoder.end());
  scanner.finish();
  return true;
}

/**
 * Reads a JSON array transcript one element at a time, with `readJsonTranscriptFile`'s
 * size cap and messages. Every read or syntax failure throws `Transcript is not readable
 * JSON`, possibly after yielding elements. A document that does not start with `[` is
 * read whole, as before, so a valid non-array throws `notArrayMessage`.
 */
export async function* readJsonArrayElements(
  filePath: string,
  options: ReadJsonArrayElementsOptions,
): AsyncGenerator<unknown, void, undefined> {
  const notReadableMessage = `Transcript is not readable JSON: ${filePath}`;
  let fileSize: number;

  try {
    fileSize = (await stat(filePath)).size;
  } catch {
    throw new Error(notReadableMessage);
  }

  if (fileSize > MAX_JSON_TRANSCRIPT_BYTES) {
    throw new Error(
      `Transcript is larger than ${String(MAX_JSON_TRANSCRIPT_BYTES / 1024 / 1024)} MiB: ${filePath}`,
    );
  }

  let isArrayDocument: boolean;

  try {
    isArrayDocument = yield* streamArrayElements(
      filePath,
      options.chunkSize ?? DEFAULT_CHUNK_SIZE_BYTES,
    );
  } catch {
    throw new Error(notReadableMessage);
  }

  if (!isArrayDocument) {
    await readJsonTranscriptFile(filePath);
    throw new Error(options.notArrayMessage);
  }
}
