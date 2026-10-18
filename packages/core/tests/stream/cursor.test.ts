import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReadDiagnostics } from '../../src/sources/parse-diagnostics.js';
import { CodexSourceAdapter } from '../../src/sources/codex/index.js';
import { MultiDirectorySourceAdapter } from '../../src/sources/multi-directory-source-adapter.js';
import { getParserVersion } from '../../src/sources/parse-fingerprint.js';
import { QwenSourceAdapter } from '../../src/sources/qwen/index.js';
import type { SourceAdapter, SourceReadDiagnostics } from '../../src/sources/source-adapter.js';
import { createSourceContext } from '../../src/sources/source-context.js';
import {
  getCursorParser,
  validateJsonlCursor,
  type ReadCursor,
  type ReadResume,
} from '../../src/stream/cursor.js';
import { readEvents } from '../../src/stream/read-events.js';
import { fixturePath } from '../helpers/fixtures.js';
import { LineLocalAdapter } from '../helpers/line-local-adapter.js';
import { canCountOpenFds, countOpenFds, waitForOpenFdCount } from '../helpers/open-fds.js';
import { mulberry32, pick, randomInt, type Random } from '../helpers/seeded-random.js';

const MIN_COVERED_BYTES = 128 * 1024;
const SEEDS_PER_ADAPTER = 40;

const tempDirs: string[] = [];

// A home that is never created and an empty environment, so no adapter sees the host's.
const context = createSourceContext({
  homeDir: path.join(os.tmpdir(), 'read-cursor-no-home'),
  env: {},
});

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

// qwen derives a fallback session id from the file's project and chats directories.
async function createSessionFile(content: string | Buffer = ''): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'read-cursor-'));
  tempDirs.push(root);
  const filePath = path.join(root, 'demo', 'chats', 'session.jsonl');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

type ReadResult = {
  events: string[];
  restarted?: boolean;
  startCalls: Array<{ restarted: boolean }>;
  cursor?: ReadCursor;
  cursorCalls: number;
};

async function readWith(
  adapter: SourceAdapter,
  filePath: string,
  options: { from?: unknown; diagnostics?: SourceReadDiagnostics } = {},
): Promise<ReadResult> {
  const result: ReadResult = { events: [], startCalls: [], cursorCalls: 0 };
  const resume: ReadResume = {
    from: options.from as ReadCursor | undefined,
    onStart: (info) => {
      result.startCalls.push(info);
    },
    onCursor: ({ cursor, restarted }) => {
      result.cursorCalls += 1;
      result.cursor = cursor;
      result.restarted = restarted;
    },
  };

  for await (const event of readEvents(adapter, filePath, {
    diagnostics: options.diagnostics,
    resume,
  })) {
    result.events.push(JSON.stringify(event));
  }

  return result;
}

async function readFull(
  adapter: SourceAdapter,
  filePath: string,
): Promise<{ events: string[]; diagnostics: SourceReadDiagnostics }> {
  const diagnostics = createReadDiagnostics();
  const events: string[] = [];

  for await (const event of readEvents(adapter, filePath, { diagnostics })) {
    events.push(JSON.stringify(event));
  }

  return { events, diagnostics };
}

function diagnosticsOf(diagnostics: SourceReadDiagnostics) {
  return {
    skippedRows: diagnostics.skippedRows,
    reasons: [...diagnostics.skippedRowReasons.entries()].sort(([left], [right]) =>
      left < right ? -1 : 1,
    ),
  };
}

const PAD_ALPHABET = ['a', 'z', '0', ' ', 'é', '漢', '😀', '\\"', '\\n'];

function padding(random: Random, length: number): string {
  let text = '';

  while (text.length < length) {
    text += pick(random, PAD_ALPHABET);
  }

  return text;
}

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
}

// Every line shape both adapters meet in real logs: usage, prefiltered, malformed,
// non-record, blank, zero usage, bad timestamps, CRLF endings and lines over 64 KiB.
function generateLine(random: Random, index: number): string {
  const pad = padding(
    random,
    random() < 0.04 ? 70_000 + randomInt(random, 60_000) : randomInt(random, 300),
  );
  const usage = `"usageMetadata":{"promptTokenCount":${1 + randomInt(random, 900)},"candidatesTokenCount":${randomInt(random, 90)},"cachedContentTokenCount":${randomInt(random, 2)}}`;
  const shape = randomInt(random, 10);

  switch (shape) {
    case 0:
      return `{"type":"user","sessionId":"s1","timestamp":"${timestamp(index)}","pad":"${pad}"}`;
    case 1:
      return `{"type":"assistant",${usage},"pad":"${pad}`;
    case 2:
      return `["usageMetadata","${pad}"]`;
    case 3:
      return pick(random, ['', '   ', '\t']);
    case 4:
      return `{"type":"assistant","sessionId":"s1","timestamp":"${timestamp(index)}","usageMetadata":{"promptTokenCount":0}}`;
    case 5:
      return `{"type":"assistant","sessionId":"s1","timestamp":"not a time",${usage}}`;
    case 6:
      return `{"type":"system",${usage},"pad":"${pad}"}`;
    default:
      return `{"type":"assistant","sessionId":"s${randomInt(random, 3)}","timestamp":"${timestamp(index)}","model":"qwen3-coder",${usage},"pad":"${pad}"}`;
  }
}

function generateContent(random: Random, minBytes: number): Buffer {
  const lines: string[] = [];
  let bytes = 0;
  let index = 0;

  while (bytes < minBytes) {
    const line = generateLine(random, index) + (random() < 0.2 ? '\r\n' : '\n');
    lines.push(line);
    bytes += Buffer.byteLength(line);
    index += 1;
  }

  const text = (random() < 0.3 ? '﻿' : '') + lines.join('');
  return Buffer.from(text, 'utf8');
}

// Ascending byte offsets in (0, length); random bytes land mid-line and mid-character.
function generateSplits(random: Random, length: number): number[] {
  const count = 3 + randomInt(random, 4);
  const splits = new Set<number>();

  while (splits.size < count) {
    splits.add(1 + randomInt(random, length - 1));
  }

  return [...splits].sort((left, right) => left - right);
}

// Writes `content` in pieces ending at each split, reading on from the last cursor after
// each piece, and returns everything the chained reads yielded.
async function readInPieces(
  adapter: SourceAdapter,
  content: Buffer,
  splits: readonly number[],
): Promise<{ events: string[]; diagnostics: SourceReadDiagnostics; reads: ReadResult[] }> {
  const filePath = await createSessionFile();
  const diagnostics = createReadDiagnostics();
  const events: string[] = [];
  const reads: ReadResult[] = [];
  let cursor: ReadCursor | undefined;
  let written = 0;

  for (const end of [...splits, content.length]) {
    await appendFile(filePath, content.subarray(written, end));
    written = end;

    const read = await readWith(adapter, filePath, { from: cursor, diagnostics });
    reads.push(read);
    events.push(...read.events);
    cursor = read.cursor;
  }

  return { events, diagnostics, reads };
}

const adapters: Array<[string, () => SourceAdapter]> = [
  ['qwen', () => new QwenSourceAdapter({ dir: os.tmpdir(), context })],
  ['line-local', () => new LineLocalAdapter()],
];

describe.each(adapters)('resuming a %s read', (_name, createAdapter) => {
  it(`equals one full read for ${String(SEEDS_PER_ADAPTER)} seeded files and split points`, async () => {
    const adapter = createAdapter();

    for (let seed = 1; seed <= SEEDS_PER_ADAPTER; seed += 1) {
      const random = mulberry32(seed);
      // Most files fit in one of the reader's 1 MiB chunks; a few cross several.
      const content = generateContent(
        random,
        seed % 10 === 0 ? 2_200_000 : 2_000 + randomInt(random, 300_000),
      );
      const splits = generateSplits(random, content.length);
      const full = await readFull(adapter, await createSessionFile(content));
      const pieces = await readInPieces(adapter, content, splits);

      expect(pieces.events, `seed ${String(seed)}`).toEqual(full.events);
      expect(diagnosticsOf(pieces.diagnostics), `seed ${String(seed)}`).toEqual(
        diagnosticsOf(full.diagnostics),
      );
      expect(
        pieces.reads.map((read) => read.restarted),
        `seed ${String(seed)}`,
      ).toEqual([true, ...splits.map(() => false)]);
      expect(pieces.reads.at(-1)?.cursor?.offset).toBe(content.length);
    }
  }, 120_000);

  it('chains several short resumes', async () => {
    const adapter = createAdapter();
    const content = generateContent(mulberry32(7), 300_000);
    const full = await readFull(adapter, await createSessionFile(content));
    const pieces = await readInPieces(adapter, content, [1_000, 5_000, 30_000, 200_000]);

    expect(pieces.events).toEqual(full.events);
    expect(diagnosticsOf(pieces.diagnostics)).toEqual(diagnosticsOf(full.diagnostics));
    expect(pieces.reads.map((read) => read.restarted)).toEqual([true, false, false, false, false]);
    expect(pieces.reads.map((read) => read.startCalls)).toEqual([
      [{ restarted: true }],
      [{ restarted: false }],
      [{ restarted: false }],
      [{ restarted: false }],
      [{ restarted: false }],
    ]);
  });
});

describe('resuming across read chunks', () => {
  it('hashes the prefix across several 1 MiB chunks', async () => {
    const adapter = new LineLocalAdapter();
    const content = generateContent(mulberry32(13), 3_000_000);
    const full = await readFull(adapter, await createSessionFile(content));
    const pieces = await readInPieces(adapter, content, [100, 2_600_000, 2_700_000]);

    expect(pieces.events).toEqual(full.events);
    expect(pieces.reads.map((read) => read.restarted)).toEqual([true, false, false, false]);
  });
});

describe('cursor invalidation', () => {
  const content = generateContent(mulberry32(11), 400_000);

  async function readHalf(adapter: SourceAdapter = new LineLocalAdapter()) {
    const filePath = await createSessionFile(content.subarray(0, 300_000));
    const first = await readWith(adapter, filePath);
    const cursor = first.cursor;

    if (!cursor || cursor.offset <= MIN_COVERED_BYTES) {
      throw new Error('the fixture must consume more than 128 KiB');
    }

    return { filePath, cursor };
  }

  async function expectRestart(adapter: SourceAdapter, filePath: string, from: unknown) {
    const resumed = await readWith(adapter, filePath, { from });
    const full = await readFull(adapter, filePath);

    expect(resumed.startCalls).toEqual([{ restarted: true }]);
    expect(resumed.restarted).toBe(true);
    expect(resumed.events).toEqual(full.events);
  }

  it('restarts when a byte near the start changes', async () => {
    const { filePath, cursor } = await readHalf();
    const rewritten = Buffer.from(content);
    rewritten[10] ^= 0x01;
    await writeFile(filePath, rewritten);

    expect(cursor.offset).toBeLessThan(rewritten.length);
    await expectRestart(new LineLocalAdapter(), filePath, cursor);
  });

  it('restarts when a byte just before the offset changes', async () => {
    const { filePath, cursor } = await readHalf();
    const rewritten = Buffer.from(content);
    rewritten[cursor.offset - 100] ^= 0x01;
    await writeFile(filePath, rewritten);

    await expectRestart(new LineLocalAdapter(), filePath, cursor);
  });

  it('restarts when a byte far from both ends of the covered prefix changes', async () => {
    const { filePath, cursor } = await readHalf();
    const rewritten = Buffer.from(content);
    rewritten[Math.floor(cursor.offset / 2)] ^= 0x01;
    await writeFile(filePath, rewritten);

    await expectRestart(new LineLocalAdapter(), filePath, cursor);
  });

  it('restarts when the file is shorter than the cursor offset', async () => {
    const { filePath, cursor } = await readHalf();
    // Cut back to an earlier line end, so the file still ends in a line feed.
    await truncate(filePath, content.lastIndexOf(0x0a, cursor.offset - 2) + 1);

    await expectRestart(new LineLocalAdapter(), filePath, cursor);
  });

  it('rejects a cursor when the file shrinks between its size check and the prefix read', async () => {
    const { filePath, cursor } = await readHalf();
    const parser = getCursorParser(new LineLocalAdapter());
    const handle = await open(filePath, 'r');

    try {
      const statBeforeCut = await handle.stat();
      await expect(validateJsonlCursor(handle, cursor, parser)).resolves.toBeDefined();

      // The size check passes, then the prefix read comes up short.
      vi.spyOn(handle, 'stat').mockResolvedValue(statBeforeCut);
      await truncate(filePath, cursor.offset - 100);

      await expect(validateJsonlCursor(handle, cursor, parser)).resolves.toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('restarts when the parser version changed', async () => {
    const { filePath, cursor } = await readHalf();

    await expectRestart(new LineLocalAdapter(2), filePath, cursor);
  });

  it('restarts when the cursor came from another source', async () => {
    const { filePath, cursor } = await readHalf();

    await expectRestart(new QwenSourceAdapter({ dir: os.tmpdir(), context }), filePath, cursor);
  });

  it.each<[string, (cursor: ReadCursor) => unknown]>([
    ['null', () => null],
    ['a string', () => 'cursor'],
    ['an empty object', () => ({})],
    ['a negative offset', (cursor) => ({ ...cursor, offset: -1 })],
    ['a fractional offset', (cursor) => ({ ...cursor, offset: 1.5 })],
    ['another format', (cursor) => ({ ...cursor, format: 'sqlite' })],
    ['another version', (cursor) => ({ ...cursor, version: 1 })],
    ['a missing hash', (cursor) => ({ ...cursor, prefixHash: undefined })],
  ])('restarts on a cursor that is %s', async (_label, corrupt) => {
    const { filePath, cursor } = await readHalf();

    await expectRestart(new LineLocalAdapter(), filePath, corrupt(cursor));
  });
});

describe('resume callbacks', () => {
  it('reports a zero cursor for an empty file', async () => {
    const filePath = await createSessionFile();
    const adapter = new QwenSourceAdapter({ dir: os.tmpdir(), context });
    const read = await readWith(adapter, filePath);

    expect(read.startCalls).toEqual([{ restarted: true }]);
    expect(read.cursor).toEqual({
      format: 'jsonl',
      version: 2,
      parser: `qwen@${getParserVersion(adapter)}`,
      offset: 0,
      prefixHash: createHash('sha256').digest('hex'),
    });
  });

  it('leaves an unterminated final line unread and undiagnosed', async () => {
    const line = `{"type":"assistant","sessionId":"s1","timestamp":"${timestamp(0)}","usageMetadata":{"promptTokenCount":5}}`;
    const filePath = await createSessionFile(`${line}\n{"type":"assistant","usageMetadata":`);
    const diagnostics = createReadDiagnostics();
    const read = await readWith(new QwenSourceAdapter({ dir: os.tmpdir(), context }), filePath, {
      diagnostics,
    });

    expect(read.events).toHaveLength(1);
    expect(diagnostics.skippedRows).toBe(0);
    expect(read.cursor?.offset).toBe(Buffer.byteLength(line) + 1);
  });

  it('does not report a cursor when the consumer stops early, and closes the file', async () => {
    const content = generateContent(mulberry32(3), 50_000);
    const filePath = await createSessionFile(content);
    const fdsBefore = canCountOpenFds ? countOpenFds() : 0;
    let cursorCalls = 0;
    const resume: ReadResume = {
      onCursor: () => {
        cursorCalls += 1;
      },
    };

    for await (const event of readEvents(
      new QwenSourceAdapter({ dir: os.tmpdir(), context }),
      filePath,
      {
        resume,
      },
    )) {
      expect(event.kind).toBe('usage');
      break;
    }

    expect(cursorCalls).toBe(0);

    if (canCountOpenFds) {
      await waitForOpenFdCount(fdsBefore);
    }
  });

  it('does not report a cursor when the consumer throws', async () => {
    const filePath = await createSessionFile(generateContent(mulberry32(4), 50_000));
    let cursorCalls = 0;
    const consume = async () => {
      for await (const event of readEvents(new LineLocalAdapter(), filePath, {
        resume: { onCursor: () => (cursorCalls += 1) },
      })) {
        throw new Error(`consumer failed on ${event.kind}`);
      }
    };

    await expect(consume()).rejects.toThrow('consumer failed');
    expect(cursorCalls).toBe(0);
  });

  it('calls neither callback when the requested kinds exclude usage', async () => {
    const filePath = await createSessionFile(generateContent(mulberry32(5), 5_000));
    const calls: string[] = [];

    for await (const event of readEvents(
      new QwenSourceAdapter({ dir: os.tmpdir(), context }),
      filePath,
      {
        kinds: ['message'],
        resume: { onStart: () => calls.push('start'), onCursor: () => calls.push('cursor') },
      },
    )) {
      calls.push(event.kind);
    }

    expect(calls).toEqual([]);
  });

  it('is ignored by an adapter that is not incremental', async () => {
    const adapter = new CodexSourceAdapter({ dir: os.tmpdir(), context });
    const filePath = fixturePath(import.meta.url, '../fixtures/codex/session-token-count.jsonl');
    const calls: string[] = [];
    const withResume: string[] = [];

    for await (const event of readEvents(adapter, filePath, {
      resume: { onStart: () => calls.push('start'), onCursor: () => calls.push('cursor') },
    })) {
      withResume.push(JSON.stringify(event));
    }

    expect(calls).toEqual([]);
    expect(withResume).toEqual((await readFull(adapter, filePath)).events);
    expect(withResume.length).toBeGreaterThan(0);
  });

  it('passes through a multi-directory adapter', async () => {
    const content = generateContent(mulberry32(6), 100_000);
    const filePath = await createSessionFile(content.subarray(0, 60_000));
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'read-cursor-empty-'));
    tempDirs.push(emptyDir);
    const adapter = new MultiDirectorySourceAdapter([
      new QwenSourceAdapter({ dir: emptyDir, context }),
      new QwenSourceAdapter({ dir: path.dirname(path.dirname(path.dirname(filePath))), context }),
    ]);
    await adapter.discoverFiles();

    expect(adapter.capabilities?.incremental).toBe(true);

    const first = await readWith(adapter, filePath);
    await appendFile(filePath, content.subarray(60_000));
    await appendFile(
      filePath,
      `{"type":"assistant","sessionId":"s1","timestamp":"${timestamp(0)}","usageMetadata":{"promptTokenCount":5}}\n`,
    );
    const second = await readWith(adapter, filePath, { from: first.cursor });
    const full = await readFull(adapter, filePath);

    expect(second.restarted).toBe(false);
    expect([...first.events, ...second.events]).toEqual(full.events);
    expect(second.events.length).toBeGreaterThan(0);
  });
});
