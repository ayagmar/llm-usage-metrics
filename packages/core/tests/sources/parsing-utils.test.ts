import { describe, expect, it, vi } from 'vitest';

import {
  asTrimmedText,
  hasPositiveUsageOrCostSignal,
  isBlankText,
  normalizeTimestampCandidate,
  parseFiniteNumber,
  resolveTotalTokens,
  resolveUsageTotalTokens,
  splitPromptIncludingCachedTokens,
  toFiniteNumber,
  toNonNegativeInteger,
  toNonNegativeNumber,
  toNumberLike,
  toStrictNonNegativeInteger,
  toStrictNonNegativeNumber,
  toTokenCount,
} from '../../src/sources/parsing-utils.js';

describe('source parsing helpers', () => {
  it('normalizes trimmed text values', () => {
    expect(asTrimmedText('  hello  ')).toBe('hello');
    expect(asTrimmedText('   ')).toBeUndefined();
    expect(asTrimmedText(123)).toBeUndefined();
  });

  it('checks blank strings', () => {
    expect(isBlankText('')).toBe(true);
    expect(isBlankText('   ')).toBe(true);
    expect(isBlankText(' value ')).toBe(false);
  });

  it('converts unknown values to NumberLike safely', () => {
    expect(toNumberLike(42)).toBe(42);
    expect(toNumberLike('42')).toBe('42');
    expect(toNumberLike(null)).toBeNull();
    expect(toNumberLike(undefined)).toBeUndefined();
    expect(toNumberLike({ value: 42 })).toBeUndefined();
    expect(toNumberLike([42])).toBeUndefined();
  });

  it('converts NumberLike values to finite numbers', () => {
    expect(toFiniteNumber(42)).toBe(42);
    expect(toFiniteNumber('42')).toBe(42);
    expect(toFiniteNumber('')).toBeUndefined();
    expect(toFiniteNumber('   ')).toBeUndefined();
    expect(toFiniteNumber('not-a-number')).toBeUndefined();
    expect(toFiniteNumber(null)).toBeUndefined();
    expect(toFiniteNumber(undefined)).toBeUndefined();
    expect(toFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(toFiniteNumber(-5)).toBe(-5);
  });

  // Columns: parseFiniteNumber, toNonNegativeNumber, toNonNegativeInteger,
  // toStrictNonNegativeNumber, toStrictNonNegativeInteger, toTokenCount.
  const none = undefined;
  it.each<[unknown, ...(number | undefined)[]]>([
    [2.5, 2.5, 2.5, 2, 2.5, 2, 2],
    ['2.5', 2.5, 2.5, 2, none, none, 2],
    [' 7 ', 7, 7, 7, none, none, 7],
    [0, 0, 0, 0, 0, 0, 0],
    ['', none, none, none, none, none, 0],
    ['   ', none, none, none, none, none, 0],
    ['abc', none, none, none, none, none, 0],
    [Number.NaN, none, none, none, none, none, 0],
    ['NaN', none, none, none, none, none, 0],
    [Number.POSITIVE_INFINITY, none, none, none, none, none, 0],
    ['Infinity', none, none, none, none, none, 0],
    [-3.5, -3.5, none, none, none, none, 0],
    ['-3.5', -3.5, none, none, none, none, 0],
    [null, none, none, none, none, none, 0],
    [undefined, none, none, none, none, none, 0],
    [true, none, none, none, none, none, 0],
    [{}, none, none, none, none, none, 0],
  ])('coerces %j per variant', (input, ...expected) => {
    expect([
      parseFiniteNumber(input),
      toNonNegativeNumber(input),
      toNonNegativeInteger(input),
      toStrictNonNegativeNumber(input),
      toStrictNonNegativeInteger(input),
      toTokenCount(input),
    ]).toEqual(expected);
  });

  it('detects positive usage or cost signal', () => {
    expect(hasPositiveUsageOrCostSignal([0, undefined, 5], 0)).toBe(true);
    expect(hasPositiveUsageOrCostSignal([0, undefined], 0.01)).toBe(true);
    expect(hasPositiveUsageOrCostSignal([0, undefined], 0)).toBe(false);
    expect(hasPositiveUsageOrCostSignal([undefined], undefined)).toBe(false);
    expect(hasPositiveUsageOrCostSignal([-5, '-1'], -0.01)).toBe(false);
    expect(hasPositiveUsageOrCostSignal(['5'], 0)).toBe(true);
  });

  it('resolves declared or component total tokens', () => {
    expect(resolveTotalTokens(10, 5)).toBe(10);
    expect(resolveTotalTokens(0, 5)).toBe(5);
    expect(resolveTotalTokens(0, 0)).toBe(0);
  });

  it('normalizes ISO, numeric, and numeric-string timestamps', () => {
    expect(normalizeTimestampCandidate('2026-02-12T20:01:00.000Z')).toBe(
      '2026-02-12T20:01:00.000Z',
    );
    expect(normalizeTimestampCandidate(1_707_768_000)).toBe('2024-02-12T20:00:00.000Z');
    expect(normalizeTimestampCandidate('1707768000')).toBe('2024-02-12T20:00:00.000Z');
    expect(normalizeTimestampCandidate('1707768000000')).toBe('2024-02-12T20:00:00.000Z');
    expect(normalizeTimestampCandidate('not-a-timestamp')).toBeUndefined();
  });

  it('reads an ISO date and time with no offset as UTC whatever the machine zone', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');

    try {
      expect(normalizeTimestampCandidate('2026-02-12T20:01:00')).toBe('2026-02-12T20:01:00.000Z');
      expect(normalizeTimestampCandidate(' 2026-02-12 20:01:00.250 ')).toBe(
        '2026-02-12T20:01:00.250Z',
      );
      expect(normalizeTimestampCandidate('2026-02-12T20:01')).toBe('2026-02-12T20:01:00.000Z');
      expect(normalizeTimestampCandidate('2026-02-12T20:01:00+02:00')).toBe(
        '2026-02-12T18:01:00.000Z',
      );
      expect(normalizeTimestampCandidate('2026-02-12')).toBe('2026-02-12T00:00:00.000Z');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects short numeric values that are not plausible epoch timestamps', () => {
    expect(normalizeTimestampCandidate(2026)).toBeUndefined();
    expect(normalizeTimestampCandidate('2026')).toBeUndefined();
    expect(normalizeTimestampCandidate('20260214')).toBeUndefined();
    expect(normalizeTimestampCandidate('1e3')).toBeUndefined();
  });

  it('rejects invalid Date instances', () => {
    expect(normalizeTimestampCandidate(new Date(Number.NaN))).toBeUndefined();
  });

  it('resolves a usage total without counting reasoning twice', () => {
    expect(
      resolveUsageTotalTokens({ inputTokens: 100, outputTokens: 80, cacheReadTokens: 20 }),
    ).toBe(200);
    expect(resolveUsageTotalTokens({ inputTokens: '100', outputTokens: 80, totalTokens: 0 })).toBe(
      180,
    );
    expect(resolveUsageTotalTokens({ inputTokens: 100, outputTokens: 80, totalTokens: 500 })).toBe(
      500,
    );
    expect(resolveUsageTotalTokens({ cacheWriteTokens: null })).toBe(0);
  });
});

describe('token count helpers', () => {
  it('splits a prompt count that includes cache reads into disjoint buckets', () => {
    expect(splitPromptIncludingCachedTokens(1200, 1000)).toEqual({
      inputTokens: 200,
      cacheReadTokens: 1000,
    });
    // A cached count above the prompt count never yields negative input.
    expect(splitPromptIncludingCachedTokens(100, 150)).toEqual({
      inputTokens: 0,
      cacheReadTokens: 150,
    });
  });

  it('reads token counts from numbers and numeric text, and 0 for anything else', () => {
    expect(toTokenCount(42)).toBe(42);
    expect(toTokenCount(' 17 ')).toBe(17);
    expect(toTokenCount(-3)).toBe(0);
    expect(toTokenCount('many')).toBe(0);
    expect(toTokenCount(undefined)).toBe(0);
    expect(toTokenCount({ tokens: 5 })).toBe(0);
  });
});
