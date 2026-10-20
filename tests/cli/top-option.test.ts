import { describe, expect, it } from 'vitest';

import { limitRows, parseTopRowsOption, resolveTopRowLimit } from '../../src/cli/top-option.js';

describe('--top', () => {
  it('lets 0 show every row where rows are limited by default', () => {
    expect(parseTopRowsOption('0')).toBe(0);
    for (const top of ['-1', '1.5', 'abc', '']) {
      expect(() => parseTopRowsOption(top), top).toThrow('--top must be a non-negative integer');
    }
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
    expect(limitRows(Array.from({ length: 4777 }, String), 20, 'sessions').limitNote).toBe(
      'Showing top 20 of 4,777 sessions by cost. Use --top 0 for all.',
    );
  });
});
