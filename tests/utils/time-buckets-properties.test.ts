import { describe, expect, it } from 'vitest';

import {
  getLocalHour,
  getLocalHourBucket,
  getPeriodKey,
  type ReportGranularity,
} from '../../src/utils/time-buckets.js';
import { mulberry32, randomInt, shuffle, type Random } from '../helpers/seeded-random.js';

const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * SECOND_MS;

// DST zones, half-hour and 45-minute offsets (some with a 30-minute DST shift), a zone
// that skipped a day, and zones whose historic local mean time has a seconds offset
// (Amsterdam +00:19:32 before 1937, Monrovia -00:44:30 until 1972).
const timezones = [
  'UTC',
  'Europe/Paris',
  'America/New_York',
  'America/St_Johns',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Tehran',
  'Australia/Adelaide',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'Pacific/Apia',
  'Europe/Amsterdam',
  'Africa/Monrovia',
] as const;

const fixedYears = [1916, 1920, 1936, 1937, 1940, 1971, 1972, 2011, 2025, 2026] as const;
const granularities: readonly ReportGranularity[] = ['daily', 'weekly', 'monthly'];

const formatterByZone = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterByZone.get(timezone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterByZone.set(timezone, formatter);
  }

  return formatter;
}

function getIntlParts(timestampMs: number, timezone: string): Record<string, number> {
  const parts: Record<string, number> = {};

  for (const part of getFormatter(timezone).formatToParts(new Date(timestampMs))) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }

  return parts;
}

function getOffsetMs(timestampMs: number, timezone: string): number {
  const parts = getIntlParts(timestampMs, timezone);
  const wallClockMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wallClockMs - Math.floor(timestampMs / SECOND_MS) * SECOND_MS;
}

const transitionsByZoneYear = new Map<string, number[]>();

/** The first second of each offset change in a year, found by bisecting 6-hour steps. */
function findTransitions(timezone: string, year: number): number[] {
  const key = `${timezone} ${year}`;
  const cached = transitionsByZoneYear.get(key);

  if (cached) {
    return cached;
  }

  const transitions: number[] = [];
  transitionsByZoneYear.set(key, transitions);
  const end = Date.UTC(year + 1, 0, 1);

  for (let start = Date.UTC(year, 0, 1); start < end; start += 6 * HOUR_MS) {
    const next = start + 6 * HOUR_MS;

    if (getOffsetMs(start, timezone) === getOffsetMs(next, timezone)) {
      continue;
    }

    let low = start;
    let high = next;

    while (high - low > SECOND_MS) {
      const middle = low + Math.floor((high - low) / 2 / SECOND_MS) * SECOND_MS;

      if (getOffsetMs(middle, timezone) === getOffsetMs(start, timezone)) {
        low = middle;
      } else {
        high = middle;
      }
    }

    transitions.push(high);
  }

  return transitions;
}

function collectInstants(random: Random, timezone: string): number[] {
  const instants: number[] = [];
  const years = [...fixedYears, ...Array.from({ length: 2 }, () => 1900 + randomInt(random, 140))];

  for (const year of years) {
    for (const transition of findTransitions(timezone, year)) {
      instants.push(transition - SECOND_MS, transition - 1, transition, transition + 1);

      for (let sample = 0; sample < 12; sample += 1) {
        instants.push(transition + randomInt(random, 72 * HOUR_MS) - 36 * HOUR_MS);
      }
    }

    // Local midnights are where a day window starts or ends.
    for (let sample = 0; sample < 12; sample += 1) {
      const instant = Date.UTC(year, randomInt(random, 12), 1 + randomInt(random, 28), 12);
      const midnight = instant - getOffsetMs(instant, timezone) - 12 * HOUR_MS;
      instants.push(midnight - 1, midnight, midnight + randomInt(random, 2 * SECOND_MS));
    }
  }

  const from = Date.UTC(1900, 0, 1);
  const to = Date.UTC(2040, 0, 1);

  for (let sample = 0; sample < 400; sample += 1) {
    instants.push(from + Math.floor(random() * (to - from)));
  }

  // Years below 1000 print unpadded, and years below 100 take the general parse path.
  for (let sample = 0; sample < 40; sample += 1) {
    // Date.UTC would read years below 100 as 19xx.
    const instant = new Date(Date.UTC(2000, 0, 1, 12, 34, 56, 789));
    instant.setUTCFullYear(1 + randomInt(random, 999), randomInt(random, 12), 1);
    instants.push(instant.getTime());
  }

  return shuffle(instants, random);
}

/** Today's date key formatting: month and day padded, the year as a plain number. */
function getIntlPeriodKey(
  timestampMs: number,
  granularity: 'daily' | 'monthly',
  timezone: string,
): string {
  const parts = getIntlParts(timestampMs, timezone);
  const month = String(parts.month).padStart(2, '0');

  return granularity === 'monthly'
    ? `${parts.year}-${month}`
    : `${parts.year}-${month}-${String(parts.day).padStart(2, '0')}`;
}

describe('local date keys for canonical timestamps', () => {
  for (const seed of [1, 0x5eed, 20261015]) {
    it(`match Intl and the general parse path over DST, odd offsets and LMT (seed ${seed})`, () => {
      const random = mulberry32(seed);

      for (const timezone of timezones) {
        for (const instant of collectInstants(random, timezone)) {
          const canonical = new Date(instant).toISOString();
          // The same instant in another ISO form skips the canonical reader and goes
          // through the per-string memo and `new Date`, as every timestamp did before.
          const general = canonical.replace('Z', '+00:00');
          const label = `${timezone} ${canonical} (seed ${seed})`;

          expect(getPeriodKey(canonical, 'daily', timezone), label).toBe(
            getIntlPeriodKey(instant, 'daily', timezone),
          );
          expect(getPeriodKey(canonical, 'monthly', timezone), label).toBe(
            getIntlPeriodKey(instant, 'monthly', timezone),
          );
          expect(getLocalHour(canonical, timezone), label).toBe(
            getIntlParts(instant, timezone).hour,
          );

          for (const granularity of granularities) {
            expect(getPeriodKey(canonical, granularity, timezone), `${label} ${granularity}`).toBe(
              getPeriodKey(general, granularity, timezone),
            );
          }
        }
      }
    }, 30_000);
  }

  it('keeps unpadded keys for years below 1000', () => {
    expect(getPeriodKey('0500-03-01T12:00:00.000Z', 'daily', 'UTC')).toBe('500-03-01');
    expect(getPeriodKey('0050-03-01T12:00:00.000Z', 'daily', 'UTC')).toBe('50-03-01');
    expect(getPeriodKey('0050-03-01T12:00:00.000Z', 'monthly', 'UTC')).toBe('50-03');
  });

  it('rejects canonical-shaped timestamps that are not real instants, as before', () => {
    for (const timestamp of [
      '2026-13-01T10:00:00.000Z',
      '2026-00-10T10:00:00.000Z',
      '2026-01-10T25:00:00.000Z',
      '2026-01-10T10:60:00.000Z',
      '2026-01-1aT10:00:00.000Z',
    ]) {
      expect(() => getPeriodKey(timestamp, 'daily', 'UTC'), timestamp).toThrow(
        `Invalid event timestamp: ${timestamp}`,
      );
    }
  });

  it('reads canonical-shaped timestamps out of field range as Date.parse does', () => {
    // Date.parse rolls these over; the canonical reader leaves them to it.
    expect(getPeriodKey('2026-02-30T10:00:00.000Z', 'daily', 'UTC')).toBe('2026-03-02');
    expect(getPeriodKey('2026-01-10T24:00:00.000Z', 'daily', 'UTC')).toBe('2026-01-11');
    expect(getPeriodKey('2025-02-29T23:30:00.000Z', 'daily', 'Asia/Kolkata')).toBe('2025-03-02');
  });
});

describe('hourly keys', () => {
  for (const seed of [7, 0xb0b, 20261101]) {
    it(`share the daily key's date and Intl's hour over DST, odd offsets and LMT (seed ${seed})`, () => {
      const random = mulberry32(seed);

      for (const timezone of timezones) {
        for (const instant of collectInstants(random, timezone)) {
          const canonical = new Date(instant).toISOString();
          const general = canonical.replace('Z', '+00:00');
          const label = `${timezone} ${canonical} (seed ${seed})`;
          const hourlyKey = getPeriodKey(canonical, 'hourly', timezone);
          const separator = hourlyKey.lastIndexOf(' ');

          expect(hourlyKey.slice(0, separator), label).toBe(
            getPeriodKey(canonical, 'daily', timezone),
          );
          expect(hourlyKey.slice(separator + 1), label).toBe(
            `${String(getIntlParts(instant, timezone).hour).padStart(2, '0')}:00`,
          );
          expect(getPeriodKey(general, 'hourly', timezone), label).toBe(hourlyKey);
          expect(getLocalHourBucket(canonical, timezone).offsetMs, label).toBe(
            getOffsetMs(instant, timezone),
          );
        }
      }
    }, 30_000);
  }

  it('give a DST fall-back hour one key with two offsets, and the spring-forward hour none', () => {
    const timezone = 'America/New_York';
    // 2026-11-01 01:00 EDT is 05:00Z; 01:00 EST is 06:00Z.
    const firstOccurrence = getLocalHourBucket('2026-11-01T05:30:00.000Z', timezone);
    const secondOccurrence = getLocalHourBucket('2026-11-01T06:30:00.000Z', timezone);

    expect(firstOccurrence.key).toBe('2026-11-01 01:00');
    expect(secondOccurrence.key).toBe('2026-11-01 01:00');
    expect(firstOccurrence.offsetMs - secondOccurrence.offsetMs).toBe(HOUR_MS);
    expect(getPeriodKey('2026-11-01T04:59:59.999Z', 'hourly', timezone)).toBe('2026-11-01 00:00');
    expect(getPeriodKey('2026-11-01T07:00:00.000Z', 'hourly', timezone)).toBe('2026-11-01 02:00');

    // 2026-03-08: 01:59:59 EST (06:59:59Z) is followed by 03:00 EDT (07:00Z).
    const springForwardKeys = new Set(
      Array.from({ length: 24 * 60 }, (_, minute) =>
        getPeriodKey(
          new Date(Date.UTC(2026, 2, 8, 5) + minute * 60_000).toISOString(),
          'hourly',
          timezone,
        ),
      ).filter((key) => key.startsWith('2026-03-08')),
    );

    expect(springForwardKeys.has('2026-03-08 01:00')).toBe(true);
    expect(springForwardKeys.has('2026-03-08 02:00')).toBe(false);
    expect(springForwardKeys.has('2026-03-08 03:00')).toBe(true);
  });

  it('keeps the daily key and the hour for years below 1000 and in a 45-minute zone', () => {
    expect(getPeriodKey('0050-03-01T12:00:00.000Z', 'hourly', 'UTC')).toBe('50-03-01 12:00');
    // Kathmandu is +05:45: 18:14Z is 23:59, 18:15Z is midnight the next day.
    expect(getPeriodKey('2026-06-15T18:14:59.999Z', 'hourly', 'Asia/Kathmandu')).toBe(
      '2026-06-15 23:00',
    );
    expect(getPeriodKey('2026-06-15T18:15:00.000Z', 'hourly', 'Asia/Kathmandu')).toBe(
      '2026-06-16 00:00',
    );
  });

  it('rejects invalid timestamps as the other granularities do', () => {
    expect(() => getPeriodKey('not a timestamp', 'hourly', 'UTC')).toThrow(
      'Invalid event timestamp: not a timestamp',
    );
  });
});
