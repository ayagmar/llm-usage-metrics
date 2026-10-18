import { describe, expect, it } from 'vitest';

import {
  limitRows,
  parsePositiveTopOption,
  parseTopRowsOption,
  resolveTopRowLimit,
} from '../../src/cli/top-option.js';

describe('--top', () => {
  it('accepts a positive integer where a top list is always shown', () => {
    expect(parsePositiveTopOption(undefined)).toBeUndefined();
    expect(parsePositiveTopOption(' 2 ')).toBe(2);

    for (const top of ['0', '01', '-1', '1.5', 'abc', '']) {
      expect(() => parsePositiveTopOption(top), top).toThrow('--top must be a positive integer');
    }
  });

  it('lets 0 show every row where rows are limited by default', () => {
    expect(parseTopRowsOption('0')).toBe(0);
    expect(() => parseTopRowsOption('-1')).toThrow('--top must be a non-negative integer');
    expect(resolveTopRowLimit(0)).toBeUndefined();
    expect(resolveTopRowLimit(undefined)).toBe(20);
    expect(resolveTopRowLimit(undefined, true)).toBeUndefined();
    expect(resolveTopRowLimit(5, true)).toBe(5);
  });

  it('names what the limit left out', () => {
    expect(limitRows(['a', 'b', 'c'], 2, 'tools', 'calls')).toEqual({
      rows: ['a', 'b'],
      limitNote: 'Showing top 2 of 3 tools by calls. Use --top 0 for all.',
    });
    expect(limitRows(['a'], 2, 'tools')).toEqual({ rows: ['a'] });
  });
});
