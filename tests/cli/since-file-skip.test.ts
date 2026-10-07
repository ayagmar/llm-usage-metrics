import { describe, expect, it } from 'vitest';

import { getSinceFileSkipCutoffMs } from '../../src/cli/parse/since-file-skip.js';

describe('getSinceFileSkipCutoffMs', () => {
  it('returns one day before UTC midnight of --since', () => {
    expect(getSinceFileSkipCutoffMs('2026-03-10')).toBe(Date.parse('2026-03-09T00:00:00.000Z'));
  });

  it('stays before local midnight of --since in the furthest-ahead accepted offsets', () => {
    for (const offset of ['+14:00', '+23:59']) {
      const localMidnightMs = Date.parse(`2026-03-10T00:00:00.000${offset}`);

      expect(getSinceFileSkipCutoffMs('2026-03-10')).toBeLessThan(localMidnightMs);
    }
  });

  it('disables skipping without a valid --since', () => {
    expect(getSinceFileSkipCutoffMs(undefined)).toBeUndefined();
    expect(getSinceFileSkipCutoffMs('')).toBeUndefined();
    expect(getSinceFileSkipCutoffMs('not-a-date')).toBeUndefined();
  });
});
