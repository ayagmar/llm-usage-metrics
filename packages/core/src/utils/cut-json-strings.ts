/**
 * The values a read never uses, by key path. `true` marks a value whose strings are all
 * unused, at any depth; an object maps an object's keys to their own spec. An array's
 * elements take the spec of the array.
 */
export type UnusedJsonValues = true | { readonly [key: string]: UnusedJsonValues };

// Shorter lines and strings cost less to parse than to walk.
const MIN_WALKED_LINE_BYTES = 4096;
const MIN_CUT_STRING_BYTES = 256;
// Deeper values are left to JSON.parse.
const MAX_DEPTH = 64;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

class InvalidLine extends Error {}

/**
 * The JSON line with every long string under `unused` emptied, so parsing it skips their
 * bytes; undefined when it cuts nothing. `JSON.parse` of the result fails exactly when it
 * fails on the line, and differs from it only in the emptied strings.
 */
export function cutUnusedJsonStrings(
  lineBytes: Buffer,
  unused: UnusedJsonValues,
): Buffer | undefined {
  if (lineBytes.length < MIN_WALKED_LINE_BYTES) {
    return undefined;
  }

  const scanner = new LineScanner(lineBytes);

  try {
    if (scanner.skipWhitespace(scanner.scanValue(0, unused, 0)) !== lineBytes.length) {
      return undefined;
    }
  } catch (error) {
    if (error instanceof InvalidLine) {
      return undefined;
    }

    throw error;
  }

  return scanner.cutLine();
}

/**
 * Walks one line the way JSON.parse reads it: every quote outside a string opens one, so
 * the strings found here are the line's strings, even in an invalid line.
 */
class LineScanner {
  private readonly length: number;
  // The line as 4-byte words, from its first aligned byte, to skip plain runs a word at a time.
  private readonly words: Uint32Array;
  private readonly wordStart: number;
  // Each cut string's opening and closing quote offsets, in order.
  private readonly cuts: number[] = [];

  public constructor(private readonly bytes: Buffer) {
    this.length = bytes.length;
    this.wordStart = (4 - (bytes.byteOffset & 3)) & 3;
    this.words = new Uint32Array(
      bytes.buffer,
      bytes.byteOffset + this.wordStart,
      Math.max(0, this.length - this.wordStart) >>> 2,
    );
  }

  public cutLine(): Buffer | undefined {
    if (this.cuts.length === 0) {
      return undefined;
    }

    const pieces: Buffer[] = [];
    let offset = 0;

    for (let index = 0; index < this.cuts.length; index += 2) {
      pieces.push(this.bytes.subarray(offset, this.cuts[index] + 1));
      offset = this.cuts[index + 1];
    }

    pieces.push(this.bytes.subarray(offset));
    return Buffer.concat(pieces);
  }

  public skipWhitespace(start: number): number {
    let index = start;

    while (index < this.length) {
      const byte = this.bytes[index];

      if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
        break;
      }

      index += 1;
    }

    return index;
  }

  // Returns the offset just past the value at `start`, after leading whitespace.
  public scanValue(start: number, unused: UnusedJsonValues | undefined, depth: number): number {
    const index = this.skipWhitespace(start);
    const byte = this.bytes[index];

    if (byte === QUOTE) {
      if (unused !== true) {
        return this.scanString(index, false);
      }

      const end = this.scanString(index, true);

      if (end - index > MIN_CUT_STRING_BYTES) {
        this.cuts.push(index, end - 1);
      }

      return end;
    }

    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      if (unused === undefined || depth >= MAX_DEPTH) {
        return this.skipContainer(index);
      }

      return byte === OPEN_BRACE
        ? this.scanObject(index, unused, depth)
        : this.scanArray(index, unused, depth);
    }

    // A number or literal: JSON.parse checks it, since its bytes stay as they are. It ends
    // at the first byte no number or literal holds, so a quote after it still opens a string.
    let end = index;

    while (end < this.length && isLiteralByte(this.bytes[end])) {
      end += 1;
    }

    if (end === index) {
      throw new InvalidLine();
    }

    return end;
  }

  private scanObject(start: number, unused: UnusedJsonValues, depth: number): number {
    let index = this.skipWhitespace(start + 1);

    if (this.bytes[index] === CLOSE_BRACE) {
      return index + 1;
    }

    for (;;) {
      if (this.bytes[index] !== QUOTE) {
        throw new InvalidLine();
      }

      const keyEnd = this.scanString(index, false);
      // An escaped key reads as no match here, which only leaves its value uncut.
      const childUnused =
        unused === true
          ? true
          : lookup(unused, this.bytes.toString('latin1', index + 1, keyEnd - 1));
      index = this.skipWhitespace(keyEnd);

      if (this.bytes[index] !== COLON) {
        throw new InvalidLine();
      }

      index = this.skipWhitespace(this.scanValue(index + 1, childUnused, depth + 1));

      if (this.bytes[index] === CLOSE_BRACE) {
        return index + 1;
      }

      if (this.bytes[index] !== COMMA) {
        throw new InvalidLine();
      }

      index = this.skipWhitespace(index + 1);
    }
  }

  private scanArray(start: number, unused: UnusedJsonValues, depth: number): number {
    let index = this.skipWhitespace(start + 1);

    if (this.bytes[index] === CLOSE_BRACKET) {
      return index + 1;
    }

    for (;;) {
      index = this.skipWhitespace(this.scanValue(index, unused, depth + 1));

      if (this.bytes[index] === CLOSE_BRACKET) {
        return index + 1;
      }

      if (this.bytes[index] !== COMMA) {
        throw new InvalidLine();
      }

      index += 1;
    }
  }

  // Skips a container nothing is cut from: only its strings and nesting matter here, and
  // JSON.parse checks the rest.
  private skipContainer(start: number): number {
    let depth = 0;
    let index = start;

    while (index < this.length) {
      const byte = this.bytes[index];

      if (byte === QUOTE) {
        index = this.scanString(index, false);
        continue;
      }

      if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
        depth += 1;
      } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        depth -= 1;

        if (depth === 0) {
          return index + 1;
        }
      }

      index += 1;
    }

    throw new InvalidLine();
  }

  // Returns the offset just past the closing quote. A string that is cut must be valid
  // JSON as it stands, since JSON.parse never sees it: no raw control byte, no bad escape.
  private scanString(start: number, validate: boolean): number {
    let index = start + 1;

    while (index < this.length) {
      if (validate) {
        index = this.skipPlainWords(index);
      }

      const byte = this.bytes[index];

      // Most bytes are none of quote, backslash or a control byte.
      if (
        byte > BACKSLASH ||
        (byte > QUOTE && byte < BACKSLASH) ||
        byte === 0x20 ||
        byte === 0x21
      ) {
        index += 1;
      } else if (byte === QUOTE) {
        return index + 1;
      } else if (byte === BACKSLASH) {
        index += validate ? this.escapeLength(index) : 2;
      } else if (validate) {
        throw new InvalidLine();
      } else {
        index += 1;
      }
    }

    throw new InvalidLine();
  }

  // The offset of the first word from `start` that holds a quote, a backslash or a control
  // byte; `start` itself when it is not word-aligned.
  private skipPlainWords(start: number): number {
    const offset = start - this.wordStart;

    if ((offset & 3) !== 0 || offset < 0) {
      return start;
    }

    const words = this.words;
    let word = offset >>> 2;

    while (word < words.length) {
      const value = words[word];
      const quotes = value ^ 0x22222222;
      const backslashes = value ^ 0x5c5c5c5c;

      // A byte's high bit is set when it is zero in the xors or below 0x20 in the word.
      if (
        (((quotes - 0x01010101) & ~quotes) |
          ((backslashes - 0x01010101) & ~backslashes) |
          ((value - 0x20202020) & ~value)) &
        0x80808080
      ) {
        break;
      }

      word += 1;
    }

    return this.wordStart + word * 4;
  }

  private escapeLength(index: number): number {
    switch (this.bytes[index + 1]) {
      case QUOTE:
      case BACKSLASH:
      case 0x2f: // /
      case 0x62: // b
      case 0x66: // f
      case 0x6e: // n
      case 0x72: // r
      case 0x74: // t
        return 2;
      case 0x75: // u
        for (let offset = 2; offset < 6; offset += 1) {
          if (!isHexDigit(this.bytes[index + offset])) {
            throw new InvalidLine();
          }
        }

        return 6;
      default:
        throw new InvalidLine();
    }
  }
}

function lookup(
  unused: Exclude<UnusedJsonValues, true>,
  key: string,
): UnusedJsonValues | undefined {
  return Object.hasOwn(unused, key) ? unused[key] : undefined;
}

// The bytes of numbers, true, false and null.
function isLiteralByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    byte === 0x2b || // +
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x45 // E
  );
}

function isHexDigit(byte: number | undefined): boolean {
  return (
    byte !== undefined &&
    ((byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x46) ||
      (byte >= 0x61 && byte <= 0x66))
  );
}
