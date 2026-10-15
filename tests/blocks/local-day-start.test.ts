import { describe, expect, it } from 'vitest';

import { getLocalDayStartMs } from '../../src/blocks/local-day-start.js';
import { getCurrentLocalDateKey, shiftLocalDateKey } from '../../src/utils/time-buckets.js';

describe('getLocalDayStartMs', () => {
  it('is local midnight', () => {
    expect(new Date(getLocalDayStartMs('2026-06-15', 'UTC')).toISOString()).toBe(
      '2026-06-15T00:00:00.000Z',
    );
    expect(new Date(getLocalDayStartMs('2026-06-15', 'America/New_York')).toISOString()).toBe(
      '2026-06-15T04:00:00.000Z',
    );
    expect(new Date(getLocalDayStartMs('2026-06-15', 'Asia/Kolkata')).toISOString()).toBe(
      '2026-06-14T18:30:00.000Z',
    );
  });

  it('starts a day whose midnight is skipped by DST at the end of the gap', () => {
    // Chile moves 00:00 to 01:00 on 2026-09-06.
    expect(new Date(getLocalDayStartMs('2026-09-06', 'America/Santiago')).toISOString()).toBe(
      '2026-09-06T04:00:00.000Z',
    );
  });

  it('is the first instant of the day in every zone, across a year', () => {
    for (const timezone of [
      'UTC',
      'America/New_York',
      'Europe/Berlin',
      'Asia/Kolkata',
      'Australia/Lord_Howe',
      'America/Santiago',
      'Pacific/Apia',
    ]) {
      for (let day = 0; day < 366; day += 1) {
        const dateKey = shiftLocalDateKey('2026-01-01', day);
        const startMs = getLocalDayStartMs(dateKey, timezone);

        expect(getCurrentLocalDateKey(timezone, new Date(startMs)), `${timezone} ${dateKey}`).toBe(
          dateKey,
        );
        expect(
          getCurrentLocalDateKey(timezone, new Date(startMs - 1)) < dateKey,
          `${timezone} ${dateKey}`,
        ).toBe(true);
      }
    }
  });
});
