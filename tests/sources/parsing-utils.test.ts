import { describe, expect, it } from 'vitest';

import {
  asTrimmedText,
  hasPositiveUsageOrCostSignal,
  isBlankText,
  normalizeTimestampCandidate,
  resolveTotalTokens,
  toFiniteNumber,
  toNumberLike,
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

  it('rejects short numeric values that are not plausible epoch timestamps', () => {
    expect(normalizeTimestampCandidate(2026)).toBeUndefined();
    expect(normalizeTimestampCandidate('2026')).toBeUndefined();
    expect(normalizeTimestampCandidate('20260214')).toBeUndefined();
    expect(normalizeTimestampCandidate('1e3')).toBeUndefined();
  });

  it('rejects invalid Date instances', () => {
    expect(normalizeTimestampCandidate(new Date(Number.NaN))).toBeUndefined();
  });
});
