import type * as fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_JSON_TRANSCRIPT_BYTES } from '../../src/sources/read-json-file.js';
import { collect } from '../../src/stream/collect.js';
import { readJsonArrayElements } from '../../src/sources/read-json-array-elements.js';
import { canCountOpenFds, countOpenFds, waitForOpenFdCount } from '../helpers/open-fds.js';
import { mulberry32, pick, randomInt, type Random } from '../helpers/seeded-random.js';

// Fails every `read` on a file handle after `failReadsAfter` successful reads.
const ioFault = vi.hoisted(() => ({ failReadsAfter: undefined as number | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();

  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>): Promise<FileHandle> => {
      const handle = await actual.open(...args);
      const failReadsAfter = ioFault.failReadsAfter;

      if (failReadsAfter === undefined) {
        return handle;
      }

      let reads = 0;
      const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<unknown>;

      return Object.assign(handle, {
        read: (...readArgs: unknown[]) => {
          reads += 1;
          return reads > failReadsAfter
            ? Promise.reject(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }))
            : read(...readArgs);
        },
      });
    },
  };
});

const NOT_ARRAY_MESSAGE = 'Task history is not a JSON array';
const CHUNK_SIZES = [1, 2, 3, 4, 5, 6, 7, undefined];

const tempDirs: string[] = [];

afterEach(async () => {
  ioFault.failReadsAfter = undefined;
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'read-json-array-elements-'));
  tempDirs.push(tempDir);
  return tempDir;
}

// Oracle: the whole-file read of 06b05ec (`readBoundedJsonFile`, `readJsonTranscriptFile`
// and the Cline array check), copied as it was.
async function readArrayWhole(filePath: string): Promise<unknown[]> {
  let readResult:
    { ok: true; value: unknown } | { ok: false; reason: 'file_too_large' | 'json_parse_error' };

  try {
    const fileStat = await stat(filePath);

    readResult =
      fileStat.size > MAX_JSON_TRANSCRIPT_BYTES
        ? { ok: false, reason: 'file_too_large' }
        : { ok: true, value: JSON.parse(await readFile(filePath, 'utf8')) as unknown };
  } catch {
    readResult = { ok: false, reason: 'json_parse_error' };
  }

  if (!readResult.ok) {
    throw new Error(
      readResult.reason === 'file_too_large'
        ? `Transcript is larger than ${String(MAX_JSON_TRANSCRIPT_BYTES / 1024 / 1024)} MiB: ${filePath}`
        : `Transcript is not readable JSON: ${filePath}`,
    );
  }

  if (!Array.isArray(readResult.value)) {
    throw new Error(NOT_ARRAY_MESSAGE);
  }

  return readResult.value as unknown[];
}

type Outcome = { elements: unknown[] } | { error: string };

async function toOutcome(read: () => Promise<unknown[]>): Promise<Outcome> {
  try {
    return { elements: await read() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function readStreamed(filePath: string, chunkSize?: number): Promise<unknown[]> {
  return collect(
    readJsonArrayElements(filePath, { notArrayMessage: NOT_ARRAY_MESSAGE, chunkSize }),
  );
}

const STRING_PIECES = ['a', 'Z', ' ', ',', ']', '}', '[', '{', 'é', '日本', '😀', ' '];
const ESCAPES = ['\\"', '\\\\', '\\/', '\\n', '\\t', '\\u00e9', '\\ud83d\\ude00'];
const WHITESPACE = ['', '', ' ', '\n', '\t', '\r\n', '  '];

function randomWhitespace(random: Random): string {
  return pick(random, WHITESPACE);
}

function randomStringLiteral(random: Random): string {
  let body = '';

  for (let count = randomInt(random, 5); count > 0; count -= 1) {
    body += random() < 0.3 ? pick(random, ESCAPES) : pick(random, STRING_PIECES);
  }

  return `"${body}"`;
}

/** JSON text with random whitespace between tokens. */
function randomValueText(random: Random, depth: number): string {
  const kind = randomInt(random, depth > 2 ? 4 : 6);
  const ws = () => randomWhitespace(random);

  switch (kind) {
    case 0:
      return randomStringLiteral(random);
    case 1:
      return pick(random, ['0', '-1', '12.5', '1e3', '-0.25E-2', '42']);
    case 2:
      return pick(random, ['true', 'false', 'null']);
    case 3:
      return randomStringLiteral(random);
    case 4: {
      const items = Array.from({ length: randomInt(random, 4) }, () =>
        randomValueText(random, depth + 1),
      );
      return `[${ws()}${items.join(`${ws()},${ws()}`)}${ws()}]`;
    }
    default: {
      const members = Array.from(
        { length: randomInt(random, 4) },
        () => `${randomStringLiteral(random)}${ws()}:${ws()}${randomValueText(random, depth + 1)}`,
      );
      return `{${ws()}${members.join(`${ws()},${ws()}`)}${ws()}}`;
    }
  }
}

function randomDocumentText(random: Random): string {
  const ws = () => randomWhitespace(random);

  // Mostly arrays; sometimes another document, which takes the whole-file path.
  if (random() < 0.15) {
    return `${ws()}${randomValueText(random, 0)}${ws()}`;
  }

  const elements = Array.from({ length: randomInt(random, 7) }, () => randomValueText(random, 1));
  return `${ws()}[${ws()}${elements.join(`${ws()},${ws()}`)}${ws()}]${ws()}`;
}

const MUTATION_BYTES = [
  0x5b, 0x5d, 0x7b, 0x7d, 0x2c, 0x22, 0x5c, 0x3a, 0x20, 0x0a, 0x0b, 0x00, 0x61, 0x30, 0xef, 0xbb,
  0xbf, 0xc3, 0xa9, 0x80, 0xff, 0xe2, 0xa0,
];

function mutateOneByte(random: Random, bytes: Buffer): Buffer {
  const position = randomInt(random, bytes.length + 1);
  const byte = Buffer.from([pick(random, MUTATION_BYTES)]);

  switch (randomInt(random, 3)) {
    case 0:
      return Buffer.concat([bytes.subarray(0, position), byte, bytes.subarray(position)]);
    case 1:
      return Buffer.concat([bytes.subarray(0, position), bytes.subarray(position + 1)]);
    default:
      return Buffer.concat([bytes.subarray(0, position), byte, bytes.subarray(position + 1)]);
  }
}

async function expectSameAsWholeRead(filePath: string, bytes: Buffer): Promise<void> {
  await writeFile(filePath, bytes);
  const expected = await toOutcome(() => readArrayWhole(filePath));

  for (const chunkSize of CHUNK_SIZES) {
    const actual = await toOutcome(() => readStreamed(filePath, chunkSize));
    const label = `chunk ${String(chunkSize)}: ${JSON.stringify(bytes.toString('latin1'))}`;

    if ('error' in expected) {
      // A failing read may yield elements first; only its message has to match.
      expect('error' in actual ? actual.error : actual, label).toBe(expected.error);
    } else {
      expect(actual, label).toEqual(expected);
    }
  }
}

describe('readJsonArrayElements', () => {
  it('matches the whole-file read on generated documents and one-byte mutations', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'ui_messages.json');
    const random = mulberry32(0x5eed_c11e);
    const outcomes = { elements: 0, errors: 0 };

    for (let iteration = 0; iteration < 200; iteration += 1) {
      const document = Buffer.from(randomDocumentText(random), 'utf8');
      const variants = [
        document,
        ...Array.from({ length: 3 }, () => mutateOneByte(random, document)),
      ];

      for (const bytes of variants) {
        await expectSameAsWholeRead(filePath, bytes);
        const outcome = await toOutcome(() => readArrayWhole(filePath));
        outcomes['error' in outcome ? 'errors' : 'elements'] += 1;
      }
    }

    // Both branches are exercised, so neither side of the comparison is vacuous.
    expect(outcomes.elements).toBeGreaterThan(200);
    expect(outcomes.errors).toBeGreaterThan(200);
  });

  it.each([
    ['a BOM', Buffer.from('﻿[1,2]', 'utf8')],
    ['a leading NBSP', Buffer.from(' [1,2]', 'utf8')],
    ['a leading U+2028', Buffer.from(' [1,2]', 'utf8')],
    ['an empty file', Buffer.alloc(0)],
    ['a whitespace-only file', Buffer.from(' \t\r\n ', 'utf8')],
    ['a valid object', Buffer.from(' {"a":[1]} ', 'utf8')],
    ['a valid string', Buffer.from('"[1]"', 'utf8')],
    ['trailing bytes after the array', Buffer.from('[1,2] x', 'utf8')],
    ['an unclosed array', Buffer.from('[1,2', 'utf8')],
    ['a trailing comma', Buffer.from('[1,]', 'utf8')],
  ])('reads %s like the whole-file read', async (_name, bytes) => {
    const tempDir = await createTempDir();

    await expectSameAsWholeRead(path.join(tempDir, 'ui_messages.json'), bytes);
  });

  it('keeps the not-readable and not-array messages', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'ui_messages.json');

    await writeFile(filePath, '﻿[]', 'utf8');
    await expect(readStreamed(filePath)).rejects.toThrow(
      `Transcript is not readable JSON: ${filePath}`,
    );

    await writeFile(filePath, '{}', 'utf8');
    await expect(readStreamed(filePath)).rejects.toThrow(NOT_ARRAY_MESSAGE);
  });

  it('fails a missing path and a directory as not readable', async () => {
    const tempDir = await createTempDir();
    const missingPath = path.join(tempDir, 'missing.json');

    await expect(readStreamed(missingPath)).rejects.toThrow(
      `Transcript is not readable JSON: ${missingPath}`,
    );
    await expect(readStreamed(tempDir)).rejects.toThrow(
      `Transcript is not readable JSON: ${tempDir}`,
    );
  });

  it('refuses a file over the size cap before reading it', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'ui_messages.json');
    await writeFile(filePath, '[');
    await truncate(filePath, MAX_JSON_TRANSCRIPT_BYTES + 1);
    ioFault.failReadsAfter = 0;

    await expect(readStreamed(filePath)).rejects.toThrow(
      `Transcript is larger than 64 MiB: ${filePath}`,
    );
  });

  it('yields elements read before an I/O error, then fails as not readable', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'ui_messages.json');
    await writeFile(filePath, '[1,2,3,4,5,6,7,8,9]', 'utf8');
    ioFault.failReadsAfter = 2;
    const yielded: unknown[] = [];

    await expect(
      (async () => {
        for await (const element of readJsonArrayElements(filePath, {
          notArrayMessage: NOT_ARRAY_MESSAGE,
          chunkSize: 4,
        })) {
          yielded.push(element);
        }
      })(),
    ).rejects.toThrow(`Transcript is not readable JSON: ${filePath}`);
    expect(yielded).toEqual([1, 2, 3]);
  });

  it.runIf(canCountOpenFds)('closes the file when the consumer stops early', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'ui_messages.json');
    await writeFile(filePath, JSON.stringify(Array.from({ length: 50 }, (_, index) => index)));
    const before = countOpenFds();

    for await (const element of readJsonArrayElements(filePath, {
      notArrayMessage: NOT_ARRAY_MESSAGE,
      chunkSize: 8,
    })) {
      expect(element).toBe(0);
      break;
    }

    await waitForOpenFdCount(before);
  });
});
