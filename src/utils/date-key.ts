// Calendar arithmetic on local `YYYY-MM-DD` date keys: weekdays, ISO weeks, months and key
// ranges. Pure, with no imports and no module state, so the share report's browser client
// bundles the same implementation the CLI uses (`time-buckets.ts`). Only UTC `Date` math:
// a date key has no timezone left to apply.

export type DateParts = {
  year: number;
  month: number;
  day: number;
};

/** Granularities whose keys derive from a date key alone. */
export type DateKeyGranularity = 'day' | 'week' | 'month';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days since 1970-01-01 for a calendar date. */
function toDayNumber(parts: DateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS;
}

function fromDayNumber(dayNumber: number): DateParts {
  const date = new Date(dayNumber * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function readDigits(value: string, start: number, length: number): number {
  let result = 0;

  for (let index = start; index < start + length; index += 1) {
    const digit = value.charCodeAt(index) - 48;

    if (digit < 0 || digit > 9) {
      return -1;
    }

    result = result * 10 + digit;
  }

  return result;
}

/** The date of a `YYYY-MM-DD` key, or undefined unless it is a real calendar date. */
export function parseDateKey(key: string): DateParts | undefined {
  if (key.length !== 10 || key[4] !== '-' || key[7] !== '-') {
    return undefined;
  }

  const year = readDigits(key, 0, 4);
  const month = readDigits(key, 5, 2);
  const day = readDigits(key, 8, 2);

  if (year < 0 || month < 1 || month > 12 || day < 1) {
    return undefined;
  }

  const parts = { year, month, day };
  const roundTrip = fromDayNumber(toDayNumber(parts));
  return roundTrip.month === month && roundTrip.day === day ? parts : undefined;
}

function parseDateKeyOrThrow(key: string): DateParts {
  const parts = parseDateKey(key);

  if (!parts) {
    throw new Error(`Invalid local date key: ${key}`);
  }

  return parts;
}

export function formatDateKey(parts: DateParts): string {
  return `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** Days in a calendar month (`month` from 1 to 12). */
export function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The last date key of a valid date key's month. */
export function getMonthEndDateKey(dateKey: string): string {
  const { year, month } = parseDateKeyOrThrow(dateKey);
  return formatDateKey({ year, month, day: getDaysInMonth(year, month) });
}

/** Days from `since` to `until`, both inclusive; throws on an invalid key. */
export function countDateKeyDays(since: string, until: string): number {
  return toDayNumber(parseDateKeyOrThrow(until)) - toDayNumber(parseDateKeyOrThrow(since)) + 1;
}

/** ISO day of week: 1 = Monday … 7 = Sunday. */
export function getIsoDayOfWeek(parts: DateParts): number {
  // 1970-01-01 was a Thursday (4).
  return ((((toDayNumber(parts) + 3) % 7) + 7) % 7) + 1;
}

/** The ISO week key (`2026-W05`) of a date: weeks start on Monday, week 1 holds January 4. */
export function getIsoWeekKey(parts: DateParts): string {
  const dayNumber = toDayNumber(parts);
  const thursday = dayNumber + 4 - getIsoDayOfWeek(parts);
  const weekYear = fromDayNumber(thursday).year;
  const weekNumber = Math.floor((thursday - toDayNumber({ year: weekYear, month: 1, day: 1 })) / 7);

  return `${weekYear}-W${pad2(weekNumber + 1)}`;
}

export function getMonthKey(parts: DateParts): string {
  return `${parts.year}-${pad2(parts.month)}`;
}

/** The day, ISO week or month key of a valid date key. */
export function getDateKeyPeriod(dateKey: string, granularity: DateKeyGranularity): string {
  if (granularity === 'day') {
    return dateKey;
  }

  const parts = parseDateKeyOrThrow(dateKey);
  return granularity === 'week' ? getIsoWeekKey(parts) : getMonthKey(parts);
}

/** Shifts a date key by whole days; throws on an invalid key. */
export function shiftDateKey(dateKey: string, days: number): string {
  return formatDateKey(fromDayNumber(toDayNumber(parseDateKeyOrThrow(dateKey)) + days));
}

/**
 * Every date key from `from` to `to`, both inclusive; empty when `from` is after `to`. Throws
 * on an invalid `from`.
 */
export function getDateKeyRange(from: string, to: string): string[] {
  if (from > to) {
    return [];
  }

  const range: string[] = [];

  for (
    let day = toDayNumber(parseDateKeyOrThrow(from)), key = from;
    key <= to;
    day += 1, key = formatDateKey(fromDayNumber(day))
  ) {
    range.push(key);
  }

  return range;
}

function shiftMonthKey(monthKey: string, months: number): string {
  const index = Number(monthKey.slice(0, 4)) * 12 + Number(monthKey.slice(5, 7)) - 1 + months;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

/** Monday of an ISO week key such as `2026-W05`. */
function getIsoWeekMonday(weekKey: string): DateParts {
  const jan4 = { year: Number(weekKey.slice(0, 4)), month: 1, day: 4 };
  const firstMonday = toDayNumber(jan4) - (getIsoDayOfWeek(jan4) - 1);

  return fromDayNumber(firstMonday + (Number(weekKey.slice(6)) - 1) * 7);
}

/** Every period key from `first` to `last` (inclusive), including periods without data. */
export function getPeriodKeyRange(
  first: string,
  last: string,
  granularity: DateKeyGranularity,
): string[] {
  if (granularity === 'day') {
    return getDateKeyRange(first, last);
  }

  const keys: string[] = [];

  if (granularity === 'month') {
    for (let key = first; key <= last; key = shiftMonthKey(key, 1)) {
      keys.push(key);
    }

    return keys;
  }

  for (
    let monday = toDayNumber(getIsoWeekMonday(first)), key = first;
    key <= last;
    monday += 7, key = getIsoWeekKey(fromDayNumber(monday))
  ) {
    keys.push(key);
  }

  return keys;
}
