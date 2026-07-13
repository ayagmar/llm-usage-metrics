import { describe, expect, it } from 'vitest';

import {
  getCurrentLocalDateKey,
  getIsoDayOfWeekFromDateKey,
  getLocalDateKey,
  getLocalDateKeyRange,
  getLocalHour,
  getPeriodKey,
  shiftLocalDateKey,
} from '../../src/utils/time-buckets.js';

const HOUR_MS = 60 * 60 * 1000;

const transitionTimezones = [
  'UTC',
  'Europe/Paris',
  'America/Sao_Paulo',
  'Australia/Lord_Howe',
  'Africa/Casablanca',
  'Asia/Kathmandu',
] as const;

const transitionWindows = [
  ['2026-03-25T00:00:00.000Z', '2026-04-05T00:00:00.000Z'],
  ['2026-10-20T00:00:00.000Z', '2026-11-05T00:00:00.000Z'],
  ['2026-02-10T00:00:00.000Z', '2026-03-25T00:00:00.000Z'],
] as const;

const directFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDirectFormatter(timezone: string): Intl.DateTimeFormat {
  const cachedFormatter = directFormatterCache.get(timezone);

  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  directFormatterCache.set(timezone, formatter);
  return formatter;
}

function getDirectLocalDateKey(timestampIso: string, timezone: string): string {
  const parts = getDirectFormatter(timezone).formatToParts(new Date(timestampIso));
  const year = getDirectPart(parts, 'year');
  const month = getDirectPart(parts, 'month');
  const day = getDirectPart(parts, 'day');
  return `${year}-${month}-${day}`;
}

function getDirectPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  const value = parts.find((part) => part.type === type)?.value;

  if (!value) {
    throw new Error(`Missing ${type} in direct formatter output`);
  }

  return value;
}

function collectHourlyTimestamps(startIso: string, endIso: string): string[] {
  const timestamps: string[] = [];

  for (let ms = Date.parse(startIso); ms < Date.parse(endIso); ms += HOUR_MS) {
    timestamps.push(new Date(ms).toISOString());
  }

  return timestamps;
}

describe('time bucket helpers', () => {
  it('uses Monday-based weekly boundaries with ISO-like week keys', () => {
    expect(getPeriodKey('2026-01-04T12:00:00Z', 'weekly', 'UTC')).toBe('2026-W01');
    expect(getPeriodKey('2026-01-05T12:00:00Z', 'weekly', 'UTC')).toBe('2026-W02');
  });

  it('uses ISO week-years at calendar-year boundaries', () => {
    expect(getPeriodKey('2025-12-29T12:00:00Z', 'weekly', 'UTC')).toBe('2026-W01');
    expect(getPeriodKey('2026-01-01T12:00:00Z', 'weekly', 'UTC')).toBe('2026-W01');
    expect(getPeriodKey('2026-12-31T12:00:00Z', 'weekly', 'UTC')).toBe('2026-W53');
    expect(getPeriodKey('2027-01-01T12:00:00Z', 'weekly', 'UTC')).toBe('2026-W53');
    expect(getPeriodKey('2027-01-03T12:00:00Z', 'weekly', 'UTC')).toBe('2026-W53');
    expect(getPeriodKey('2027-01-04T12:00:00Z', 'weekly', 'UTC')).toBe('2027-W01');
  });

  it('applies timezone before week-year bucketing', () => {
    expect(getPeriodKey('2026-12-31T23:30:00Z', 'weekly', 'UTC')).toBe('2026-W53');
    expect(getPeriodKey('2026-12-31T23:30:00Z', 'weekly', 'Pacific/Auckland')).toBe('2026-W53');
  });

  it('applies timezone when generating daily keys', () => {
    expect(getPeriodKey('2026-01-04T23:30:00Z', 'daily', 'UTC')).toBe('2026-01-04');
    expect(getPeriodKey('2026-01-04T23:30:00Z', 'daily', 'Asia/Tokyo')).toBe('2026-01-05');
    expect(getPeriodKey('2026-12-31T23:30:00Z', 'daily', 'UTC')).toBe('2026-12-31');
    expect(getPeriodKey('2026-12-31T23:30:00Z', 'daily', 'Pacific/Auckland')).toBe('2027-01-01');
  });

  it('formats monthly keys as YYYY-MM', () => {
    expect(getPeriodKey('2026-08-14T00:00:00Z', 'monthly', 'UTC')).toBe('2026-08');
  });

  it('resolves the local hour across timezone boundaries', () => {
    expect(getLocalHour('2026-06-01T23:30:00Z', 'UTC')).toBe(23);
    expect(getLocalHour('2026-06-01T23:30:00Z', 'Europe/Paris')).toBe(1);
    expect(getLocalHour('2026-06-01T00:10:00Z', 'America/New_York')).toBe(20);
  });

  it('throws on an invalid timestamp when resolving the local hour', () => {
    expect(() => getLocalHour('not-a-timestamp', 'UTC')).toThrow('Invalid event timestamp');
  });

  it('maps local date keys to ISO weekdays', () => {
    expect(getIsoDayOfWeekFromDateKey('2026-01-05')).toBe(1); // Monday
    expect(getIsoDayOfWeekFromDateKey('2026-01-10')).toBe(6); // Saturday
    expect(getIsoDayOfWeekFromDateKey('2026-01-11')).toBe(7); // Sunday
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

  it('resolves local day keys directly from timestamps', () => {
    expect(getLocalDateKey('2026-01-04T23:30:00Z', 'UTC')).toBe('2026-01-04');
    expect(getLocalDateKey('2026-01-04T23:30:00Z', 'Asia/Tokyo')).toBe('2026-01-05');
  });

  it('rejects invalid timestamps and invalid local date keys', () => {
    expect(() => getLocalDateKey('not-a-date', 'UTC')).toThrow('Invalid event timestamp');
    expect(() => shiftLocalDateKey('bad-key', 1)).toThrow('Invalid local date key');
    expect(() => shiftLocalDateKey('2026-02-30', 1)).toThrow('Invalid local date key');
  });

  it('returns an empty range when the date range is reversed', () => {
    expect(getLocalDateKeyRange('2026-03-06', '2026-03-04')).toEqual([]);
  });

  it('matches direct Intl local dates across timezone transition windows', () => {
    for (const timezone of transitionTimezones) {
      for (const [startIso, endIso] of transitionWindows) {
        for (const timestampIso of collectHourlyTimestamps(startIso, endIso)) {
          expect(getLocalDateKey(timestampIso, timezone), `${timezone} ${timestampIso}`).toBe(
            getDirectLocalDateKey(timestampIso, timezone),
          );
        }
      }
    }
  });

  it('resolves timestamps around a local midnight boundary', () => {
    expect(getLocalDateKey('2026-03-29T21:59:59.999Z', 'Europe/Paris')).toBe('2026-03-29');
    expect(getLocalDateKey('2026-03-29T22:00:00.000Z', 'Europe/Paris')).toBe('2026-03-30');
    expect(getLocalDateKey('2026-03-29T22:00:00.001Z', 'Europe/Paris')).toBe('2026-03-30');
  });

  it('keeps cached local dates correct for out-of-order lookups', () => {
    const lookups = [
      ['2026-01-10T12:00:00.000Z', 'UTC'],
      ['2026-08-10T12:00:00.000Z', 'UTC'],
      ['2026-01-10T12:00:00.000Z', 'UTC'],
      ['2026-01-10T12:00:00.000Z', 'Asia/Tokyo'],
      ['2026-08-10T12:00:00.000Z', 'Asia/Tokyo'],
      ['2026-01-10T12:00:00.000Z', 'Asia/Tokyo'],
    ] as const;

    for (const [timestampIso, timezone] of lookups) {
      expect(getLocalDateKey(timestampIso, timezone)).toBe(
        getDirectLocalDateKey(timestampIso, timezone),
      );
    }
  });

  it('keeps the invalid timestamp error text unchanged', () => {
    expect(() => getLocalDateKey('not-a-date', 'UTC')).toThrow(
      'Invalid event timestamp: not-a-date',
    );
  });
});
