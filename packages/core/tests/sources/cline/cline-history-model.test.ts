import type * as fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadHistoryModel } from '../../../src/sources/cline/cline-history-model.js';
import { asTrimmedText } from '../../../src/sources/parsing-utils.js';
import { canCountOpenFds, countOpenFds, waitForOpenFdCount } from '../../helpers/open-fds.js';
import { mulberry32, pick, randomInt, type Random } from '../../helpers/seeded-random.js';

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

const CHUNK_SIZES = [1, 2, 3, 4, 5, 6, 7, undefined];
const tempDirs: string[] = [];

afterEach(async () => {
  ioFault.failReadsAfter = undefined;
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cline-history-model-'));
  tempDirs.push(tempDir);
  return tempDir;
}

// Oracle: the whole-file scan of 06b05ec (`cline-task-parser.ts`), copied as it was.
const ENVIRONMENT_DETAILS_OPEN_TAG = '<environment_details>';
const ENVIRONMENT_DETAILS_CLOSE_TAG = '</environment_details>';
const MODEL_OPEN_TAG = '<model>';
const MODEL_CLOSE_TAG = '</model>';

function findLastTaggedBlock(
  content: string,
  openTag: string,
  closeTag: string,
): string | undefined {
  let lastBlock: string | undefined;
  let searchFrom = 0;

  for (;;) {
    const start = content.indexOf(openTag, searchFrom);

    if (start === -1) {
      return lastBlock;
    }

    const end = content.indexOf(closeTag, start + openTag.length);

    if (end === -1) {
      return lastBlock;
    }

    searchFrom = end + closeTag.length;
    lastBlock = content.slice(start, searchFrom);
  }
}

function findFirstTaggedText(
  content: string,
  openTag: string,
  closeTag: string,
): string | undefined {
  const start = content.indexOf(openTag);

  if (start === -1) {
    return undefined;
  }

  const end = content.indexOf(closeTag, start + openTag.length);
  return end === -1 ? undefined : content.slice(start + openTag.length, end);
}

// The original read the file with `readFile(historyPath, 'utf8')`; decoding the generated
// bytes the same way skips that read.
function loadHistoryModelWhole(content: string): string | undefined {
  const lastEnvironmentDetails = findLastTaggedBlock(
    content,
    ENVIRONMENT_DETAILS_OPEN_TAG,
    ENVIRONMENT_DETAILS_CLOSE_TAG,
  );

  if (!lastEnvironmentDetails) {
    return undefined;
  }

  return asTrimmedText(
    findFirstTaggedText(lastEnvironmentDetails, MODEL_OPEN_TAG, MODEL_CLOSE_TAG),
  );
}

const TAG_PIECES = [
  ENVIRONMENT_DETAILS_OPEN_TAG,
  ENVIRONMENT_DETAILS_CLOSE_TAG,
  MODEL_OPEN_TAG,
  MODEL_CLOSE_TAG,
  '<environment_det',
  '</environment_',
  '<mod',
  '</model',
  '<',
  '>',
];
const TEXT_PIECES = [
  ' ',
  '\n',
  'claude-3.7-sonnet',
  'gpt-5',
  'é',
  '日本語',
  '😀',
  ' x ',
  '"',
  '\\',
];
const RAW_BYTE_PIECES = [[0xff], [0xe2, 0x82], [0xc3], [0xf0, 0x9f, 0x98], [0xbf]];

function randomNoise(random: Random, maxPieces: number): Buffer[] {
  const pieces: Buffer[] = [];

  for (let count = randomInt(random, maxPieces); count > 0; count -= 1) {
    const roll = random();

    if (roll < 0.3) {
      pieces.push(Buffer.from(pick(random, TAG_PIECES), 'utf8'));
    } else if (roll < 0.95) {
      pieces.push(Buffer.from(pick(random, TEXT_PIECES), 'utf8'));
    } else {
      pieces.push(Buffer.from(pick(random, RAW_BYTE_PIECES)));
    }
  }

  return pieces;
}

/** Noise mixed with mostly well-formed blocks, some with a model, some left open. */
function randomHistory(random: Random): Buffer {
  const pieces: Buffer[] = [];

  for (let count = randomInt(random, 5); count > 0; count -= 1) {
    pieces.push(...randomNoise(random, 6));
    pieces.push(Buffer.from(ENVIRONMENT_DETAILS_OPEN_TAG, 'utf8'));
    pieces.push(...randomNoise(random, 4));

    if (random() < 0.7) {
      pieces.push(Buffer.from(MODEL_OPEN_TAG, 'utf8'), ...randomNoise(random, 4));
      pieces.push(Buffer.from(MODEL_CLOSE_TAG, 'utf8'));
    }

    pieces.push(...randomNoise(random, 4));

    if (random() < 0.85) {
      pieces.push(Buffer.from(ENVIRONMENT_DETAILS_CLOSE_TAG, 'utf8'));
    }
  }

  pieces.push(...randomNoise(random, 6));
  return Buffer.concat(pieces);
}

interface GeneratedHistory {
  path: string;
  bytes: Buffer;
  expected: string | undefined;
}

const GENERATED_HISTORY_COUNT = 600;

describe('loadHistoryModel on generated histories', () => {
  let generatedDir: string;
  const histories: GeneratedHistory[] = [];

  // Each history is written once and read back at every chunk size.
  beforeAll(async () => {
    generatedDir = await mkdtemp(path.join(os.tmpdir(), 'cline-history-model-generated-'));
    const random = mulberry32(0x0c11_7e5d);

    for (let index = 0; index < GENERATED_HISTORY_COUNT; index += 1) {
      const bytes = randomHistory(random);
      const historyPath = path.join(generatedDir, `history-${String(index)}.json`);
      histories.push({
        path: historyPath,
        bytes,
        expected: loadHistoryModelWhole(bytes.toString('utf8')),
      });
    }

    await Promise.all(histories.map((history) => writeFile(history.path, history.bytes)));
  });

  afterAll(async () => {
    await rm(generatedDir, { recursive: true, force: true });
  });

  it('finds a model in enough histories that a scanner returning nothing could not pass', () => {
    const modelsFound = histories.filter((history) => history.expected !== undefined).length;
    expect(modelsFound).toBeGreaterThan(150);
  });

  // One test per chunk size, so each gets its own timeout: chunk size 1 reads one byte per
  // call and takes the longest, several times longer on Windows CI than on Linux.
  it.each(CHUNK_SIZES)(
    'matches the whole-file scan at chunk size %s',
    async (chunkSize) => {
      for (const history of histories) {
        expect(
          await loadHistoryModel(history.path, chunkSize),
          JSON.stringify(history.bytes.toString('latin1')),
        ).toBe(history.expected);
      }
    },
    30_000,
  );
});

describe('loadHistoryModel', () => {
  it('returns the last complete block model, ignoring an unclosed block after it', async () => {
    const tempDir = await createTempDir();
    const historyPath = path.join(tempDir, 'api_conversation_history.json');
    await writeFile(
      historyPath,
      [
        '<environment_details><model>first</model></environment_details>',
        '<environment_details><environment_details><model> 日本 </model></environment_details>',
        '<model>outside</model>',
        '<environment_details><model>unclosed</model>',
      ].join(''),
    );

    for (const chunkSize of CHUNK_SIZES) {
      await expect(loadHistoryModel(historyPath, chunkSize)).resolves.toBe('日本');
    }
  });

  it('returns no model for a missing path, a directory or an I/O error mid-read', async () => {
    const tempDir = await createTempDir();
    const historyPath = path.join(tempDir, 'api_conversation_history.json');
    await writeFile(
      historyPath,
      '<environment_details><model>m</model></environment_details>'.repeat(4),
    );

    await expect(loadHistoryModel(path.join(tempDir, 'missing.json'))).resolves.toBeUndefined();
    await expect(loadHistoryModel(tempDir)).resolves.toBeUndefined();

    ioFault.failReadsAfter = 3;
    await expect(loadHistoryModel(historyPath, 64)).resolves.toBeUndefined();
  });

  it.runIf(canCountOpenFds)('closes the file after a read error', async () => {
    const tempDir = await createTempDir();
    const historyPath = path.join(tempDir, 'api_conversation_history.json');
    await writeFile(historyPath, 'x'.repeat(100));
    const before = countOpenFds();
    ioFault.failReadsAfter = 1;

    await expect(loadHistoryModel(historyPath, 8)).resolves.toBeUndefined();
    await waitForOpenFdCount(before);
  });
});
