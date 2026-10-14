import { describe, expect, it } from 'vitest';

import { compareByCodePoint } from '../src/utils/compare-by-code-point.js';

describe('compareByCodePoint', () => {
  it('returns 0 for identical strings', () => {
    expect(compareByCodePoint('gpt-4.1', 'gpt-4.1')).toBe(0);
  });

  it('orders by Unicode code point, including surrogate pairs', () => {
    const higherCodePoint = '\u{10000}';
    const lowerCodePoint = '\uE000';

    expect(compareByCodePoint(higherCodePoint, lowerCodePoint)).toBe(1);
    expect(compareByCodePoint(lowerCodePoint, higherCodePoint)).toBe(-1);
    expect([higherCodePoint, lowerCodePoint].sort(compareByCodePoint)).toEqual([
      lowerCodePoint,
      higherCodePoint,
    ]);
  });

  it('orders shorter string first when one is a code-point prefix of another', () => {
    expect(compareByCodePoint('ab', 'ab\u{1F600}')).toBe(-1);
    expect(compareByCodePoint('ab\u{1F600}', 'ab')).toBe(1);
  });
});
