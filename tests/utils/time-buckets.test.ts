import { describe, expect, it } from 'vitest';

import {
  getCurrentLocalDateKey,
  getLocalDateKeyRange,
  getPeriodKey,
  shiftLocalDateKey,
} from '../../src/utils/time-buckets.js';

describe('time bucket helpers', () => {
  it('uses Monday-based weekly boundaries with ISO-like week keys', () => {
    expect(getPeriodKey('2026-01-04T12:00:00Z', 'weekly', 'UTC')).toBe('2026-W01');
    expect(getPeriodKey('2026-01-05T12:00:00Z', 'weekly', 'UTC')).toBe('2026-W02');
  });

  it('applies timezone when generating daily keys', () => {
    expect(getPeriodKey('2026-01-04T23:30:00Z', 'daily', 'UTC')).toBe('2026-01-04');
    expect(getPeriodKey('2026-01-04T23:30:00Z', 'daily', 'Asia/Tokyo')).toBe('2026-01-05');
  });

  it('formats monthly keys as YYYY-MM', () => {
    expect(getPeriodKey('2026-08-14T00:00:00Z', 'monthly', 'UTC')).toBe('2026-08');
  });

  it('shifts local day keys by whole days', () => {
    expect(shiftLocalDateKey('2026-03-06', -1)).toBe('2026-03-05');
    expect(shiftLocalDateKey('2026-03-06', 2)).toBe('2026-03-08');
  });

  it('builds inclusive local day ranges', () => {
    expect(getLocalDateKeyRange('2026-03-04', '2026-03-06')).toEqual([
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
    ]);
  });

  it('resolves the current local date key from an injected clock', () => {
    expect(getCurrentLocalDateKey('UTC', new Date('2026-03-06T12:00:00.000Z'))).toBe('2026-03-06');
  });
});
