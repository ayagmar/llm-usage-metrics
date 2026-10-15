import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress, zstdCompressSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDshSessionLogRecords } from '../../../src/sources/dsh/dsh-session-log-reader.js';
import { asRecord } from '../../../src/utils/as-record.js';
import { mulberry32, pick, randomInt, type Random } from '../../helpers/seeded-random.js';

// The whole-buffer `.zstd` reader as it was before reads streamed (06b05ec), kept as the
// oracle the incremental slicer must match.

class OracleUnreadableError extends Error {
  public constructor(message = 'DSH session log could not be decompressed') {
    super(message);
    this.name = 'DshSessionLogUnreadableError';
  }
}

const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const UNDECODABLE_FRAME_REASON = 'undecodable_jsonl_frame';
const MAX_DECODED_FRAME_BYTES = 64 * 1024 * 1024;

type OracleOptions = {
  shouldParseLine: (lineText: string) => boolean;
  onSkippedRow: (reason: string) => void;
};

function collectFrameSlices(compressed: Buffer): { frames: Buffer[]; damagedSlices: number } {
  const frames: Buffer[] = [];
  let damagedSlices = 0;
  let offset = 0;

  while (offset < compressed.length) {
    const nextOffset = compressed.indexOf(ZSTD_FRAME_MAGIC, offset + ZSTD_FRAME_MAGIC.length);
    const slice =
      nextOffset === -1 ? compressed.subarray(offset) : compressed.subarray(offset, nextOffset);

    if (slice.subarray(0, ZSTD_FRAME_MAGIC.length).equals(ZSTD_FRAME_MAGIC)) {
      frames.push(slice);
    } else {
      damagedSlices += 1;
    }

    if (nextOffset === -1) {
      break;
    }

    offset = nextOffset;
  }

  return { frames, damagedSlices };
}

async function decodeFrame(frameBytes: Buffer): Promise<Buffer> {
  const engine = createZstdDecompress();
  const chunks: Buffer[] = [];
  let decodedBytes = 0;

  await pipeline(
    Readable.from([frameBytes]),
    engine,
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        decodedBytes += chunk.length;

        if (decodedBytes > MAX_DECODED_FRAME_BYTES) {
          callback(new OracleUnreadableError('DSH session log frame is too large'));
          return;
        }

        chunks.push(chunk);
        callback();
      },
    }),
  );

  const decoded = Buffer.concat(chunks);
  const frameConsumed = engine.bytesWritten === frameBytes.length;

  if (decoded.length === 0 || !frameConsumed) {
    throw new OracleUnreadableError('DSH session log frame is incomplete');
  }

  return decoded;
}

function* parseJsonlLines(
  text: string,
  options: OracleOptions,
): Generator<Record<string, unknown>, void, undefined> {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    if (line.length === 0 || !options.shouldParseLine(line)) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      options.onSkippedRow('json_parse_error');
      continue;
    }

    const record = asRecord(parsed);

    if (record) {
      yield record;
    }
  }
}

async function* readZstdLogOracle(
  filePath: string,
  options: OracleOptions,
): AsyncGenerator<Record<string, unknown>, void, undefined> {
  const { frames, damagedSlices } = collectFrameSlices(await readFile(filePath));
  let decodedFrames = 0;

  for (let index = 0; index < damagedSlices; index += 1) {
    options.onSkippedRow(UNDECODABLE_FRAME_REASON);
  }

  for (const frameBytes of frames) {
    let decoded: Buffer;

    try {
      decoded = await decodeFrame(frameBytes);
    } catch {
      options.onSkippedRow(UNDECODABLE_FRAME_REASON);
      continue;
    }

    decodedFrames += 1;
    yield* parseJsonlLines(decoded.toString('utf8'), options);
  }

  if (decodedFrames === 0) {
    throw new OracleUnreadableError();
  }
}

// Generated logs

type ReadEntry = { record: Record<string, unknown> } | { skipped: string };
type ReadOutcome = { entries: ReadEntry[]; error?: { name: string; message: string } };

const shouldParseLine = (line: string) => !line.startsWith('#');

async function runRead(
  read: (options: OracleOptions) => AsyncIterable<Record<string, unknown>>,
): Promise<ReadOutcome> {
  const entries: ReadEntry[] = [];

  try {
    for await (const record of read({
      shouldParseLine,
      onSkippedRow: (reason) => entries.push({ skipped: reason }),
    })) {
      entries.push({ record });
    }
  } catch (error) {
    const { name, message } = error as Error;
    return { entries, error: { name, message } };
  }

  return { entries };
}

const LINE_POOL: Buffer[] = [
  Buffer.from('{"type":"a","n":1}'),
  Buffer.from('{"type":"b","text":"é€😀"}'),
  Buffer.from('  {"type":"padded"}\r'),
  Buffer.from('{"type":'),
  Buffer.from('"n":2}'),
  Buffer.from('[1,2]'),
  Buffer.from('# filtered out'),
  Buffer.from('   '),
  Buffer.from([0x7b, 0x22, 0x74, 0x22, 0x3a, 0x22, 0xff, 0xc3, 0x22, 0x7d]),
  Buffer.from([0xe2, 0x82]),
  Buffer.from('﻿{"type":"bom"}'),
];

function frame(lines: Buffer[], trailingNewline = true): Buffer {
  const parts = lines.flatMap((line, index) => (index === 0 ? [line] : [Buffer.from('\n'), line]));
  return zstdCompressSync(Buffer.concat([...parts, Buffer.from(trailingNewline ? '\n' : '')]));
}

function randomBytes(random: Random, length: number): Buffer {
  return Buffer.from(Array.from({ length }, () => randomInt(random, 256)));
}

function generateLog(random: Random): Buffer {
  const parts: Buffer[] = [];
  const prefix = randomInt(random, 8);

  if (prefix < 3) {
    parts.push(randomBytes(random, prefix + 1));
  } else if (prefix === 3) {
    parts.push(ZSTD_FRAME_MAGIC.subarray(0, 1 + randomInt(random, 3)));
  }

  const segmentCount = randomInt(random, 7);

  for (let index = 0; index < segmentCount; index += 1) {
    const lines = Array.from({ length: 1 + randomInt(random, 3) }, () => pick(random, LINE_POOL));

    switch (pick(random, ['frame', 'frame', 'frame', 'torn', 'junk', 'magic', 'empty', 'open'])) {
      case 'frame':
        parts.push(frame(lines));
        break;
      case 'open':
        // A line torn across two frames: this frame ends mid-line.
        parts.push(frame(lines, false));
        break;
      case 'torn': {
        const whole = frame(lines);
        parts.push(whole.subarray(0, 1 + randomInt(random, whole.length - 1)));
        break;
      }
      case 'junk':
        parts.push(randomBytes(random, 1 + randomInt(random, 8)));
        break;
      case 'magic':
        parts.push(ZSTD_FRAME_MAGIC);
        break;
      default:
        parts.push(zstdCompressSync(Buffer.alloc(0)));
    }
  }

  return Buffer.concat(parts);
}

const a = Buffer.from('{"type":"a","n":1}');
const b = Buffer.from('{"type":"b","n":2}');

const NAMED_CASES: [string, Buffer][] = [
  ['empty file', Buffer.alloc(0)],
  ['one byte', Buffer.from([0x28])],
  ['three magic bytes', ZSTD_FRAME_MAGIC.subarray(0, 3)],
  ['magic only', ZSTD_FRAME_MAGIC],
  ['valid frames', Buffer.concat([frame([a]), frame([b, a]), frame([b])])],
  ['damaged middle', Buffer.concat([frame([a]), Buffer.from('junk'), frame([b])])],
  ['torn tail', Buffer.concat([frame([a]), frame([b]).subarray(0, 9)])],
  ['one junk byte first', Buffer.concat([Buffer.from([0]), frame([a]), frame([b])])],
  ['two junk bytes first', Buffer.concat([Buffer.from([0, 1]), frame([a]), frame([b])])],
  ['three junk bytes first', Buffer.concat([Buffer.from([0, 1, 2]), frame([a]), frame([b])])],
  ['four junk bytes first', Buffer.concat([Buffer.from([0, 1, 2, 3]), frame([a]), frame([b])])],
  [
    'magic split across the first four bytes',
    Buffer.concat([ZSTD_FRAME_MAGIC.subarray(0, 2), frame([a])]),
  ],
  [
    'line torn across two frames',
    Buffer.concat([frame([Buffer.from('{"type":"a",')], false), frame([Buffer.from('"n":1}')])]),
  ],
  ['only an empty frame', zstdCompressSync(Buffer.alloc(0))],
];

const CHUNK_SIZES = [1, 2, 3, 4, 5, 6, 7, undefined];
const GENERATED_CASES = 300;

describe('readDshSessionLogRecords on .zstd logs', () => {
  let root: string;
  let fileIndex = 0;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'dsh-slicer-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function expectSameAsOracle(log: Buffer, label: string): Promise<void> {
    const filePath = path.join(root, `log-${fileIndex++}.jsonl.zstd`);
    await writeFile(filePath, log);
    const expected = await runRead((options) => readZstdLogOracle(filePath, options));

    for (const readChunkBytes of CHUNK_SIZES) {
      const actual = await runRead((options) =>
        readDshSessionLogRecords(filePath, { ...options, readChunkBytes }),
      );
      expect(actual, `${label}, chunk ${readChunkBytes ?? 'default'}`).toEqual(expected);
    }
  }

  it.each(NAMED_CASES)('matches the whole-buffer reader: %s', async (label, log) => {
    await expectSameAsOracle(log, label);
  });

  it('matches the whole-buffer reader on generated logs', async () => {
    const random = mulberry32(0xd5a1);

    for (let index = 0; index < GENERATED_CASES; index += 1) {
      await expectSameAsOracle(generateLog(random), `generated case ${index}`);
    }
    // Generated-input sweeps take a few seconds alone and exceed the 5 s default when
    // parallel gate runs load the machine.
  }, 30_000);
});
