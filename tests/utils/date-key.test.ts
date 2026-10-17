import { describe, expect, it } from 'vitest';

import {
  countDateKeyDays,
  getMonthEndDateKey,
  formatDateKey,
  getDateKeyPeriod,
  getDateKeyRange,
  getIsoDayOfWeek,
  getIsoWeekKey,
  getPeriodKeyRange,
  parseDateKey,
  shiftDateKey,
} from '../../src/utils/date-key.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKeyOfDay(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

describe('date keys', () => {
  it('parses real calendar dates only', () => {
    expect(parseDateKey('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    expect(formatDateKey({ year: 2024, month: 2, day: 29 })).toBe('2024-02-29');

    for (const key of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-1-01', '2026/01/01', '']) {
      expect(parseDateKey(key), key).toBeUndefined();
    }
  });

  it('names ISO weeks at year boundaries, including 53-week years', () => {
    expect(getDateKeyPeriod('2020-12-31', 'week')).toBe('2020-W53');
    expect(getDateKeyPeriod('2021-01-03', 'week')).toBe('2020-W53');
    expect(getDateKeyPeriod('2021-01-04', 'week')).toBe('2021-W01');
    expect(getDateKeyPeriod('2024-12-30', 'week')).toBe('2025-W01');
    expect(getDateKeyPeriod('2025-12-31', 'week')).toBe('2026-W01');
    expect(getDateKeyPeriod('2026-12-31', 'week')).toBe('2026-W53');
    expect(getDateKeyPeriod('2026-10-25', 'month')).toBe('2026-10');
    expect(getDateKeyPeriod('2026-10-25', 'day')).toBe('2026-10-25');
  });

  it('starts a new ISO week exactly on each Monday over three decades', () => {
    // 2000-01-03 was a Monday, ISO week 2000-W01.
    const firstDay = Date.UTC(2000, 0, 3) / DAY_MS;
    let previousWeek = '';

    for (let day = firstDay; day < firstDay + 30 * 366; day += 1) {
      const key = dateKeyOfDay(day);
      const parts = parseDateKey(key);

      if (!parts) {
        throw new Error(`Invalid key ${key}`);
      }

      const weekday = getIsoDayOfWeek(parts);
      const week = getIsoWeekKey(parts);

      expect(weekday).toBe(((new Date(day * DAY_MS).getUTCDay() + 6) % 7) + 1);
      expect(week !== previousWeek).toBe(weekday === 1);
      previousWeek = week;
    }
  });

  it('shifts and ranges dates across month, year and leap-day boundaries', () => {
    expect(shiftDateKey('2024-02-28', 1)).toBe('2024-02-29');
    expect(shiftDateKey('2025-12-31', 1)).toBe('2026-01-01');
    expect(shiftDateKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(getDateKeyRange('2025-12-30', '2026-01-02')).toEqual([
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
    ]);
    expect(getDateKeyRange('2026-01-02', '2026-01-01')).toEqual([]);
    expect(() => shiftDateKey('2026-02-30', 1)).toThrow('Invalid local date key: 2026-02-30');
  });

  it('lists every week and month key between two keys', () => {
    expect(getPeriodKeyRange('2026-W52', '2027-W02', 'week')).toEqual([
      '2026-W52',
      '2026-W53',
      '2027-W01',
      '2027-W02',
    ]);
    expect(getPeriodKeyRange('2025-11', '2026-02', 'month')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('finds month ends and counts days across months and leap years', () => {
    expect(getMonthEndDateKey('2024-02-10')).toBe('2024-02-29');
    expect(getMonthEndDateKey('2026-02-01')).toBe('2026-02-28');
    expect(getMonthEndDateKey('2026-12-31')).toBe('2026-12-31');
    expect(countDateKeyDays('2026-02-27', '2026-03-02')).toBe(4);
    expect(countDateKeyDays('2026-03-05', '2026-03-05')).toBe(1);
    expect(() => countDateKeyDays('2026-02-30', '2026-03-01')).toThrow('Invalid local date key');
  });
});
