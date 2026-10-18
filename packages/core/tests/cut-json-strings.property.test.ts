import { describe, expect, it } from 'vitest';

import { cutUnusedJsonStrings, type UnusedJsonValues } from '../src/utils/cut-json-strings.js';

const UNUSED: UnusedJsonValues = {
  toolUseResult: true,
  message: { content: { content: true } },
};
const CASES = 400;

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

const PIECES = [
  'a',
  'é',
  '日本',
  '😀',
  '"',
  '\\',
  '\n',
  '\t',
  '\u0001',
  '/',
  ' ',
  'usage',
  '{"x":[1]}',
];

function randomText(random: () => number, maxPieces: number): string {
  const pieces: string[] = [];
  const count = Math.floor(random() * maxPieces);

  for (let index = 0; index < count; index += 1) {
    pieces.push(PIECES[Math.floor(random() * PIECES.length)]);
  }

  return pieces.join('');
}

function randomValue(random: () => number, depth: number): unknown {
  const roll = random();

  if (depth > 3 || roll < 0.3) {
    return randomText(random, random() < 0.3 ? 400 : 6);
  }

  if (roll < 0.4) {
    return [true, false, null, 0, -1.5e3, 42][Math.floor(random() * 6)];
  }

  if (roll < 0.7) {
    return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth + 1));
  }

  const keys = ['content', 'text', 'type', 'durationMs', 'stdout', 'message', 'toolUseResult'];
  return Object.fromEntries(
    Array.from({ length: Math.floor(random() * 4) }, () => [
      keys[Math.floor(random() * keys.length)],
      randomValue(random, depth + 1),
    ]),
  );
}

// A Claude-like row: long strings both where the spec cuts and where it must not.
function randomRow(random: () => number): Record<string, unknown> {
  const big = (): string => randomText(random, 1500);

  return {
    type: 'user',
    uuid: randomText(random, 4),
    message: {
      role: 'user',
      content: [
        { type: 'text', text: big() },
        { type: 'tool_result', tool_use_id: 'toolu_1', content: big(), is_error: false },
        { type: 'tool_result', content: [{ type: 'text', text: big() }, randomValue(random, 2)] },
        randomValue(random, 1),
      ],
    },
    toolUseResult: random() < 0.5 ? { stdout: big(), durationMs: 12, nested: [big()] } : big(),
    other: { content: big() },
    extra: randomValue(random, 0),
  };
}

// Spacing JSON.parse accepts, and corruptions it may reject.
function format(random: () => number, json: string): string {
  let line = random() < 0.3 ? json.replaceAll(',"', ' ,\t"').replaceAll('":', '" :\r\n ') : json;

  if (random() < 0.4) {
    const at = Math.floor(random() * line.length);
    const corruption = ['\u0000', '\\x', '\\u12', '"', '}', ']', ',', 'tru', ' ', '﻿'];
    line =
      line.slice(0, at) + corruption[Math.floor(random() * corruption.length)] + line.slice(at);
  }

  if (random() < 0.1) {
    line = line.slice(0, Math.floor(random() * line.length));
  }

  return line;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// Both parses agree, except that a string the spec marks unused may read as empty.
function expectSameExceptCut(
  lean: unknown,
  original: unknown,
  unused: UnusedJsonValues | undefined,
): void {
  if (unused === true && typeof original === 'string' && lean === '') {
    return;
  }

  if (Array.isArray(original)) {
    expect(Array.isArray(lean)).toBe(true);
    const leanItems = lean as unknown[];
    expect(leanItems).toHaveLength(original.length);
    original.forEach((item, index) => {
      expectSameExceptCut(leanItems[index], item, unused);
    });
    return;
  }

  if (typeof original === 'object' && original !== null) {
    const leanRecord = lean as Record<string, unknown>;
    expect(Object.keys(leanRecord)).toEqual(Object.keys(original));

    for (const [key, value] of Object.entries(original)) {
      const childUnused =
        unused === true || unused === undefined
          ? unused
          : Object.hasOwn(unused, key)
            ? unused[key]
            : undefined;
      expectSameExceptCut(leanRecord[key], value, childUnused);
    }

    return;
  }

  expect(lean).toEqual(original);
}

describe('cutUnusedJsonStrings', () => {
  it('parses like the line, except for emptied strings under the spec', () => {
    let cutCount = 0;

    for (let seed = 1; seed <= CASES; seed += 1) {
      const random = createRandom(seed);
      const line = format(random, JSON.stringify(randomRow(random)));
      const lineBytes = Buffer.from(line);
      const cut = cutUnusedJsonStrings(lineBytes, UNUSED);
      const original = tryParse(line);
      const lean = tryParse((cut ?? lineBytes).toString('utf8'));

      expect(lean.ok, `seed ${seed}`).toBe(original.ok);

      if (cut) {
        cutCount += 1;
        expect(cut.length).toBeLessThan(lineBytes.length);
      }

      if (original.ok && lean.ok) {
        expectSameExceptCut(lean.value, original.value, UNUSED);
      }
    }

    // Most generated rows are valid and long enough to be cut.
    expect(cutCount).toBeGreaterThan(CASES / 2);
  });

  it('cuts long unused strings and keeps the fields a read takes', () => {
    const content = 'line "one"\n'.repeat(1000);
    const row = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: content },
          { tool_use_id: 'toolu_1', type: 'tool_result', content, is_error: true },
        ],
      },
      toolUseResult: { stdout: content, durationMs: 4500 },
    };
    const cut = cutUnusedJsonStrings(Buffer.from(JSON.stringify(row)), UNUSED);

    expect(JSON.parse(cut?.toString('utf8') ?? 'null')).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: content },
          { tool_use_id: 'toolu_1', type: 'tool_result', content: '', is_error: true },
        ],
      },
      toolUseResult: { stdout: '', durationMs: 4500 },
    });
  });

  it('leaves short lines and lines with nothing to cut alone', () => {
    expect(cutUnusedJsonStrings(Buffer.from('{"toolUseResult":"short"}'), UNUSED)).toBeUndefined();
    const longKept = JSON.stringify({ message: { content: 'x'.repeat(10_000) } });
    expect(cutUnusedJsonStrings(Buffer.from(longKept), UNUSED)).toBeUndefined();
  });

  it('leaves a line whose unused string is invalid JSON to JSON.parse', () => {
    const body = 'x'.repeat(5000);
    const rawControl = `{"toolUseResult":"${body}\u0000"}`;
    const badEscape = `{"toolUseResult":"${body}\\q"}`;

    expect(cutUnusedJsonStrings(Buffer.from(rawControl), UNUSED)).toBeUndefined();
    expect(cutUnusedJsonStrings(Buffer.from(badEscape), UNUSED)).toBeUndefined();
  });
});
