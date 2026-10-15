export type ReportGranularity = 'daily' | 'weekly' | 'monthly';

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
};

type LocalDateTimeParts = LocalDateParts & {
  hour: number;
  minute: number;
  second: number;
};

/** A local date with its `YYYY-MM-DD` key, formatted once per cached day. */
type KeyedLocalDate = LocalDateParts & {
  dateKey: string;
};

type LocalDateWindow = {
  startMs: number;
  endMs: number;
  parts: KeyedLocalDate;
};

type LocalDateWindowCache = {
  last: LocalDateWindow | undefined;
  byDayIndex: Map<number, LocalDateWindow>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const SECOND_MS = 1000;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();
const localDateWindowCaches = new Map<string, LocalDateWindowCache>();

function getDateTimeFormatter(timezone: string): Intl.DateTimeFormat {
  const cachedFormatter = dateTimeFormatterCache.get(timezone);

  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  dateTimeFormatterCache.set(timezone, formatter);
  return formatter;
}

// A report buckets the same event timestamps several times (filters, windows, totals,
// active days), so the parsed local date is kept per timestamp string. The memo is
// capped: past the cap it starts over, so a long-lived process cannot keep every
// timestamp it ever saw. The cap sits well above one run's timestamps: a year of heavy
// usage across several machines reaches ~300k, and a memo that starts over mid-run
// recomputes every pass.
const MAX_MEMOIZED_TIMESTAMPS = 1_000_000;
let maxMemoizedTimestamps = MAX_MEMOIZED_TIMESTAMPS;
const localDatePartsByTimestamp = new Map<string, Map<string, KeyedLocalDate>>();

/**
 * Test seam: sets the memo cap (the default when undefined), empties the memo, and reports
 * how many timestamps one timezone's memo holds.
 *
 * @internal
 */
export const timestampMemoForTesting = {
  setCap(cap: number | undefined): void {
    maxMemoizedTimestamps = cap ?? MAX_MEMOIZED_TIMESTAMPS;
    localDatePartsByTimestamp.clear();
  },
  size(timezone: string): number {
    return localDatePartsByTimestamp.get(timezone)?.size ?? 0;
  },
};

function extractLocalDateParts(timestampIso: string, timezone: string): KeyedLocalDate {
  // The day windows below answer a canonical timestamp in a few comparisons, so it skips
  // the per-string memo, which would hold every event's timestamp.
  const canonicalMs = parseCanonicalTimestampMs(timestampIso);

  if (canonicalMs !== undefined) {
    return getCachedLocalDateParts(canonicalMs, timezone, timestampIso);
  }

  let partsByTimestamp = localDatePartsByTimestamp.get(timezone);

  if (!partsByTimestamp) {
    partsByTimestamp = new Map();
    localDatePartsByTimestamp.set(timezone, partsByTimestamp);
  }

  const cachedParts = partsByTimestamp.get(timestampIso);

  if (cachedParts) {
    return cachedParts;
  }

  const parts = parseLocalDateParts(timestampIso, timezone);

  if (partsByTimestamp.size >= maxMemoizedTimestamps) {
    partsByTimestamp.clear();
  }

  partsByTimestamp.set(timestampIso, parts);
  return parts;
}

/**
 * The instant of a canonical `YYYY-MM-DDTHH:MM:SS.mmmZ` timestamp, read from char codes,
 * or undefined for any other string. It returns a value only where `Date.parse` returns
 * the same one: every field in range, and a year of at least 100 (`Date.UTC` maps years
 * 0–99 to 1900–1999). Callers handle undefined with their general path.
 */
function parseCanonicalTimestampMs(value: string): number | undefined {
  if (
    value.length !== 24 ||
    value.charCodeAt(4) !== 45 ||
    value.charCodeAt(7) !== 45 ||
    value.charCodeAt(10) !== 84 ||
    value.charCodeAt(13) !== 58 ||
    value.charCodeAt(16) !== 58 ||
    value.charCodeAt(19) !== 46 ||
    value.charCodeAt(23) !== 90
  ) {
    return undefined;
  }

  const year = readDigits(value, 0, 4);
  const month = readDigits(value, 5, 2);
  const day = readDigits(value, 8, 2);
  const hour = readDigits(value, 11, 2);
  const minute = readDigits(value, 14, 2);
  const second = readDigits(value, 17, 2);
  const millisecond = readDigits(value, 20, 3);

  if (
    year < 100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > getDaysInMonth(year, month) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    millisecond < 0
  ) {
    return undefined;
  }

  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
}

/** The decimal value of `length` ASCII digits at `start`, or -1 if any is not a digit. */
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

function getDaysInMonth(year: number, month: number): number {
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && isLeapYear ? 29 : DAYS_IN_MONTH[month - 1];
}

function parseLocalDateParts(timestampIso: string, timezone: string): KeyedLocalDate {
  const date = new Date(timestampIso);
  const timestampMs = date.getTime();

  if (Number.isNaN(timestampMs)) {
    throw new Error(`Invalid event timestamp: ${timestampIso}`);
  }

  return getCachedLocalDateParts(timestampMs, timezone, timestampIso);
}

function getCachedLocalDateParts(
  timestampMs: number,
  timezone: string,
  timestampIso: string,
): KeyedLocalDate {
  const cache = getLocalDateWindowCache(timezone);

  if (cache.last && coversTimestamp(cache.last, timestampMs)) {
    return cache.last.parts;
  }

  const localDateTime = resolveLocalDateTimeParts(timestampMs, timezone, timestampIso);
  const offsetMs = getWallClockOffsetMs(timestampMs, localDateTime);
  const dayIndex = Math.floor((timestampMs + offsetMs) / DAY_MS);
  const cachedWindow = cache.byDayIndex.get(dayIndex);

  if (cachedWindow && coversTimestamp(cachedWindow, timestampMs)) {
    cache.last = cachedWindow;
    return cachedWindow.parts;
  }

  const window = createLocalDateWindow(dayIndex, timestampMs, offsetMs, timezone, localDateTime);
  cache.byDayIndex.set(dayIndex, window);
  cache.last = window;
  return window.parts;
}

function getLocalDateWindowCache(timezone: string): LocalDateWindowCache {
  const cachedWindows = localDateWindowCaches.get(timezone);

  if (cachedWindows) {
    return cachedWindows;
  }

  const cache = {
    last: undefined,
    byDayIndex: new Map<number, LocalDateWindow>(),
  };
  localDateWindowCaches.set(timezone, cache);
  return cache;
}

function coversTimestamp(window: LocalDateWindow, timestampMs: number): boolean {
  return window.startMs <= timestampMs && timestampMs < window.endMs;
}

function createLocalDateWindow(
  dayIndex: number,
  timestampMs: number,
  offsetMs: number,
  timezone: string,
  localDateTime: LocalDateTimeParts,
): LocalDateWindow {
  const startMs = dayIndex * DAY_MS - offsetMs;
  const endMs = startMs + DAY_MS;
  const localDate = toLocalDateParts(localDateTime);
  const parts = { ...localDate, dateKey: formatLocalDateParts(localDate) };

  if (hasStableOffsetWindow(startMs, endMs, offsetMs, timezone)) {
    return { startMs, endMs, parts };
  }

  const fallbackStartMs = floorToSecondMs(timestampMs);

  return {
    startMs: fallbackStartMs,
    endMs: fallbackStartMs + SECOND_MS,
    parts,
  };
}

function hasStableOffsetWindow(
  startMs: number,
  endMs: number,
  offsetMs: number,
  timezone: string,
): boolean {
  return (
    resolveOffsetMs(startMs, timezone) === offsetMs &&
    resolveOffsetMs(endMs - SECOND_MS, timezone) === offsetMs
  );
}

function resolveOffsetMs(timestampMs: number, timezone: string): number {
  return getWallClockOffsetMs(
    timestampMs,
    resolveLocalDateTimeParts(timestampMs, timezone, new Date(timestampMs).toISOString()),
  );
}

function getWallClockOffsetMs(timestampMs: number, localDateTime: LocalDateTimeParts): number {
  const wallClockAsUtcMs = Date.UTC(
    localDateTime.year,
    localDateTime.month - 1,
    localDateTime.day,
    localDateTime.hour,
    localDateTime.minute,
    localDateTime.second,
  );

  return wallClockAsUtcMs - floorToSecondMs(timestampMs);
}

function floorToSecondMs(timestampMs: number): number {
  return Math.floor(timestampMs / SECOND_MS) * SECOND_MS;
}

function resolveLocalDateTimeParts(
  timestampMs: number,
  timezone: string,
  timestampIso: string,
): LocalDateTimeParts {
  const formatter = getDateTimeFormatter(timezone);
  const parts = formatter.formatToParts(new Date(timestampMs));

  const year = getRequiredPart(parts, 'year', timestampIso);
  const month = getRequiredPart(parts, 'month', timestampIso);
  const day = getRequiredPart(parts, 'day', timestampIso);
  const hour = getRequiredPart(parts, 'hour', timestampIso);
  const minute = getRequiredPart(parts, 'minute', timestampIso);
  const second = getRequiredPart(parts, 'second', timestampIso);

  if (!year || !month || !day) {
    throw new Error(`Could not resolve local date parts for timestamp: ${timestampIso}`);
  }

  return { year, month, day, hour, minute, second };
}

function getRequiredPart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
  timestampIso: string,
): number {
  const value = Number(parts.find((part) => part.type === type)?.value);

  if (!Number.isFinite(value)) {
    throw new Error(`Could not resolve local date parts for timestamp: ${timestampIso}`);
  }

  return value;
}

function toLocalDateParts(localDateTime: LocalDateTimeParts): LocalDateParts {
  return {
    year: localDateTime.year,
    month: localDateTime.month,
    day: localDateTime.day,
  };
}

function createUtcDate(localDate: LocalDateParts): Date {
  return new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function formatLocalDateParts(localDate: LocalDateParts): string {
  return `${localDate.year}-${String(localDate.month).padStart(2, '0')}-${String(localDate.day).padStart(2, '0')}`;
}

function parseLocalDateKey(value: string): LocalDateParts {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`Invalid local date key: ${value}`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid local date key: ${value}`);
  }

  return {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth() + 1,
    day: parsed.getUTCDate(),
  };
}

function toIsoDayOfWeek(date: Date): number {
  const utcDay = date.getUTCDay();
  return utcDay === 0 ? 7 : utcDay;
}

function getIsoWeekParts(localDate: LocalDateParts): { weekYear: number; weekNumber: number } {
  const localUtcDate = createUtcDate(localDate);
  const isoDay = toIsoDayOfWeek(localUtcDate);

  const currentWeekMonday = addDays(localUtcDate, -(isoDay - 1));
  const currentWeekThursday = addDays(localUtcDate, 4 - isoDay);
  const weekYear = currentWeekThursday.getUTCFullYear();

  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const jan4IsoDay = toIsoDayOfWeek(jan4);
  const firstWeekMonday = addDays(jan4, -(jan4IsoDay - 1));

  const diffMs = currentWeekMonday.getTime() - firstWeekMonday.getTime();
  const weekNumber = Math.floor(diffMs / (7 * DAY_MS)) + 1;

  return { weekYear, weekNumber };
}

export function getPeriodKey(
  timestampIso: string,
  granularity: ReportGranularity,
  timezone: string,
): string {
  const localDate = extractLocalDateParts(timestampIso, timezone);

  if (granularity === 'daily') {
    return localDate.dateKey;
  }

  if (granularity === 'monthly') {
    return `${localDate.year}-${String(localDate.month).padStart(2, '0')}`;
  }

  const isoWeek = getIsoWeekParts(localDate);
  return `${isoWeek.weekYear}-W${String(isoWeek.weekNumber).padStart(2, '0')}`;
}

export function getLocalHour(timestampIso: string, timezone: string): number {
  const timestampMs = new Date(timestampIso).getTime();

  if (Number.isNaN(timestampMs)) {
    throw new Error(`Invalid event timestamp: ${timestampIso}`);
  }

  return resolveLocalDateTimeParts(timestampMs, timezone, timestampIso).hour;
}

/** ISO day of week for a local date key: 1 = Monday … 7 = Sunday. */
export function getIsoDayOfWeekFromDateKey(localDateKey: string): number {
  return toIsoDayOfWeek(createUtcDate(parseLocalDateKey(localDateKey)));
}

export function getCurrentLocalDateKey(timezone: string, now: Date = new Date()): string {
  return extractLocalDateParts(now.toISOString(), timezone).dateKey;
}

export function shiftLocalDateKey(localDateKey: string, days: number): string {
  return extractLocalDateParts(
    addDays(createUtcDate(parseLocalDateKey(localDateKey)), days).toISOString(),
    'UTC',
  ).dateKey;
}

export function getLocalDateKeyRange(from: string, to: string): string[] {
  if (from > to) {
    return [];
  }

  const range: string[] = [];
  let current = from;

  while (current <= to) {
    range.push(current);
    current = shiftLocalDateKey(current, 1);
  }

  return range;
}

function shiftMonthKey(monthKey: string, months: number): string {
  const index = Number(monthKey.slice(0, 4)) * 12 + Number(monthKey.slice(5, 7)) - 1 + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Monday of an ISO week key such as `2026-W05`. */
function getIsoWeekMonday(weekKey: string): string {
  const weekYear = Number(weekKey.slice(0, 4));
  const weekNumber = Number(weekKey.slice(6));
  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const firstMonday = addDays(jan4, -(toIsoDayOfWeek(jan4) - 1));

  return addDays(firstMonday, (weekNumber - 1) * 7)
    .toISOString()
    .slice(0, 10);
}

/** Every period key from `first` to `last` (inclusive), including periods without data. */
export function getPeriodKeyRange(
  first: string,
  last: string,
  granularity: ReportGranularity,
): string[] {
  if (granularity === 'daily') {
    return getLocalDateKeyRange(first, last);
  }

  const keys: string[] = [];

  if (granularity === 'monthly') {
    for (let key = first; key <= last; key = shiftMonthKey(key, 1)) {
      keys.push(key);
    }

    return keys;
  }

  for (
    let monday = getIsoWeekMonday(first), key = first;
    key <= last;
    monday = shiftLocalDateKey(monday, 7),
      key = getPeriodKey(`${monday}T12:00:00.000Z`, 'weekly', 'UTC')
  ) {
    keys.push(key);
  }

  return keys;
}
