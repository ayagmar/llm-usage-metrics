import { describe, expect, it } from 'vitest';

import { formatDuration, formatHours } from '../../src/render/format-duration.js';

const HOUR_MS = 3_600_000;

describe('formatHours', () => {
  it('prints whole hours with thousands separators, as the wrapped recap does', () => {
    expect(formatHours(12_345 * HOUR_MS)).toBe('12,345h');
    expect(formatHours(12.4 * HOUR_MS)).toBe('12h');
    expect(formatHours(HOUR_MS / 4)).toBe('<1h');
    expect(formatHours(0)).toBe('0h');
  });
});

describe('formatDuration', () => {
  it('prints minutes, hours and minutes, whole hours, or a dash for no time', () => {
    expect(formatDuration(0)).toBe('-');
    expect(formatDuration(20_000)).toBe('<1m');
    expect(formatDuration(119_000)).toBe('2m');
    expect(formatDuration(1_234 * 60_000)).toBe('20h 34m');
    expect(formatDuration(2 * HOUR_MS)).toBe('2h');
    expect(formatDuration(2 * HOUR_MS + 20_000)).toBe('2h');
  });
});
