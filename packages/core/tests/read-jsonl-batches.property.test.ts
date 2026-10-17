import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  readClassifiedJsonlObjectBatches,
  readJsonlObjectBatches,
  readJsonlObjects,
} from '../src/utils/read-jsonl-objects.js';

// The reader reads 1 MiB at a time; a padding line this long puts a chunk boundary inside
// the lines after it, often inside a multi-byte character.
const CHUNK_BYTES = 1024 * 1024;
// Each case may hold a line of nearly one chunk; 20 cases stay well inside the timeout when
// gates run in parallel.
const CASES = 20;

let rootDir: string;

beforeAll(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'read-jsonl-batches-'));
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function createRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS = ['a', 'é', '日本', '😀', 'usage', ' spaced ', '"quoted"'];

function randomLine(random: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];

  switch (Math.floor(random() * 8)) {
    case 0:
      return '';
    case 1:
      return pick(['   ', '\t', ' \t ']);
    case 2:
      return pick(['not-json', '{"broken":', '[1,2,3]', '"text"', 'null', '{"usage":']);
    default: {
      const record = { type: pick(['usage', 'message', 'other']), text: pick(TEXTS) };
      const json = JSON.stringify(record);
      return random() < 0.2 ? `  ${json} ` : json;
    }
  }
}

function randomFile(random: () => number): Buffer {
  const parts: Buffer[] = [];

  if (random() < 0.3) {
    parts.push(Buffer.from([0xef, 0xbb, 0xbf]));
  }

  const lineCount = 1 + Math.floor(random() * 30);
  const paddingIndex = random() < 0.6 ? Math.floor(random() * lineCount) : -1;

  for (let index = 0; index < lineCount; index += 1) {
    if (index === paddingIndex) {
      // A JSON line of three-byte characters ending a little before the chunk boundary.
      const used = parts.reduce((sum, part) => sum + part.length, 0);
      const target = CHUNK_BYTES - used - Math.floor(random() * 300);
      const count = Math.max(0, Math.floor((target - 12) / 3));
      parts.push(Buffer.from(JSON.stringify({ type: 'usage', pad: '日'.repeat(count) })));
    } else {
      parts.push(Buffer.from(randomLine(random)));
    }

    const isLast = index === lineCount - 1;

    if (!isLast || random() < 0.5) {
      parts.push(Buffer.from(random() < 0.3 ? '\r\n' : '\n'));
    }
  }

  return Buffer.concat(parts);
}

type ReferenceLine = {
  record?: Record<string, unknown>;
  malformed?: string;
  isUsageLine?: boolean;
  lineEndOffset?: number;
};

const isUsageLineBytes = (lineBytes: Buffer): boolean => lineBytes.includes('"usage"');
const shouldParseLineBytes = (lineBytes: Buffer): boolean => !lineBytes.includes('"other"');

// The reader's line rules applied to the whole file at once: split on LF, drop one
// trailing CR, strip a BOM on the first line, skip blank lines, then prefilter and parse.
function referenceRead(bytes: Buffer, start: number, resumable: boolean): ReferenceLine[] {
  const lines: ReferenceLine[] = [];
  let lineStart = start;

  while (lineStart < bytes.length) {
    const lineFeed = bytes.indexOf(0x0a, lineStart);

    if (lineFeed === -1 && resumable) {
      break;
    }

    const lineEnd = lineFeed === -1 ? bytes.length : lineFeed;
    let line = bytes.subarray(lineStart, lineEnd);

    if (line.at(-1) === 0x0d) {
      line = line.subarray(0, -1);
    }

    if (lineStart === 0 && line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) {
      line = line.subarray(3);
    }

    const entry: ReferenceLine = { lineEndOffset: lineFeed === -1 ? undefined : lineFeed + 1 };
    lines.push(entry);
    lineStart = lineEnd + 1;

    if (line.every((byte) => byte <= 0x20) || !shouldParseLineBytes(line)) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(line.toString('utf8').trim());

      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entry.record = parsed as Record<string, unknown>;
        entry.isUsageLine = isUsageLineBytes(line);
      }
    } catch {
      entry.malformed = line.toString('utf8');
    }
  }

  return lines;
}

async function readBatches(
  filePath: string,
  start?: number,
): Promise<{ batches: ReferenceLine[][]; malformed: string[]; lineEnds: number[] }> {
  const malformed: string[] = [];
  const lineEnds: number[] = [];
  const handle = start === undefined ? undefined : await open(filePath, 'r');
  const batches: ReferenceLine[][] = [];

  try {
    for await (const batch of readClassifiedJsonlObjectBatches(filePath, {
      shouldParseLineBytes,
      isUsageLineBytes,
      onMalformedLine: (lineBytes) => malformed.push(lineBytes.toString('utf8')),
      position: handle && {
        handle,
        start: start ?? 0,
        onChunk: () => undefined,
        onLineEnd: (offset) => lineEnds.push(offset),
      },
    })) {
      batches.push([...batch].map(({ record, isUsageLine }) => ({ record, isUsageLine })));
    }
  } finally {
    await handle?.close();
  }

  return { batches, malformed, lineEnds };
}

describe('batched JSONL reads', () => {
  it('match the line rules on random files, whole and resumed', async () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      const random = createRandom(seed);
      const bytes = randomFile(random);
      const filePath = path.join(rootDir, `case-${seed}.jsonl`);
      await writeFile(filePath, bytes);
      expect(await readFile(filePath)).toEqual(bytes);

      const reference = referenceRead(bytes, 0, false);
      const expected = reference
        .filter((line) => line.record)
        .map(({ record, isUsageLine }) => ({ record, isUsageLine }));
      const whole = await readBatches(filePath);

      expect(whole.batches.flat(), `seed ${seed}`).toEqual(expected);
      expect(whole.malformed, `seed ${seed}`).toEqual(
        reference.flatMap((line) => (line.malformed === undefined ? [] : [line.malformed])),
      );

      const plain: Record<string, unknown>[] = [];

      for await (const batch of readJsonlObjectBatches(filePath, { shouldParseLineBytes })) {
        plain.push(...batch);
      }

      const perRecord: Record<string, unknown>[] = [];

      for await (const record of readJsonlObjects(filePath, { shouldParseLineBytes })) {
        perRecord.push(record);
      }

      expect(plain, `seed ${seed}`).toEqual(expected.map(({ record }) => record));
      expect(perRecord, `seed ${seed}`).toEqual(plain);

      // A resumed read from 0 and from a random line end: same records, every line end
      // reported, and an unterminated last line left for the next read.
      const lineEndOffsets = reference.flatMap((line) => line.lineEndOffset ?? []);
      const starts = [0, lineEndOffsets[Math.floor(random() * lineEndOffsets.length)] ?? 0];

      for (const start of starts) {
        const resumedReference = referenceRead(bytes, start, true);
        const resumed = await readBatches(filePath, start);

        expect(resumed.batches.flat(), `seed ${seed} start ${start}`).toEqual(
          resumedReference
            .filter((line) => line.record)
            .map(({ record, isUsageLine }) => ({ record, isUsageLine })),
        );
        expect(resumed.lineEnds, `seed ${seed} start ${start}`).toEqual(
          resumedReference.map((line) => line.lineEndOffset),
        );
      }
    }
  }, 60_000);

  it('stops parsing at the record a consumer stops at', async () => {
    const filePath = path.join(rootDir, 'early-stop.jsonl');
    await writeFile(
      filePath,
      ['{"type":"session"}', 'not-json', '{"type":"message"}', ''].join('\n'),
    );
    const malformed: string[] = [];
    const records: Record<string, unknown>[] = [];

    for await (const record of readJsonlObjects(filePath, {
      onMalformedLine: (lineText) => malformed.push(lineText),
    })) {
      records.push(record);
      break;
    }

    expect(records).toEqual([{ type: 'session' }]);
    expect(malformed).toEqual([]);
  });
});
