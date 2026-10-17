import {
  getDaysInMonth,
  getIsoDayOfWeek,
  getIsoWeekKey,
  getPeriodKeyRange as getDateKeyPeriodRange,
  parseDateKey,
  readDigits,
  type DateKeyGranularity,
} from './date-key.js';

export type ReportGranularity = 'daily' | 'weekly' | 'monthly';

/** The usage reports' granularities: the calendar periods plus `hourly`. */
export type UsageGranularity = ReportGranularity | 'hourly';

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
  /** Wall clock minus UTC across the window, so the local hour needs no `Intl` call. */
  offsetMs: number;
  parts: KeyedLocalDate;
  /** The window's `YYYY-MM-DD HH:00` keys by local hour, built on first use. */
  hourKeys?: string[];
};

type LocalDateWindowCache = {
  last: LocalDateWindow | undefined;
  byDayIndex: Map<number, LocalDateWindow>;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SECOND_MS = 1000;
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
  return getCachedLocalDateWindow(timestampMs, timezone, timestampIso).parts;
}

function getCachedLocalDateWindow(
  timestampMs: number,
  timezone: string,
  timestampIso: string,
): LocalDateWindow {
  const cache = getLocalDateWindowCache(timezone);

  if (cache.last && coversTimestamp(cache.last, timestampMs)) {
    return cache.last;
  }

  const localDateTime = resolveLocalDateTimeParts(timestampMs, timezone, timestampIso);
  const offsetMs = getWallClockOffsetMs(timestampMs, localDateTime);
  const dayIndex = Math.floor((timestampMs + offsetMs) / DAY_MS);
  const cachedWindow = cache.byDayIndex.get(dayIndex);

  if (cachedWindow && coversTimestamp(cachedWindow, timestampMs)) {
    cache.last = cachedWindow;
    return cachedWindow;
  }

  const window = createLocalDateWindow(dayIndex, timestampMs, offsetMs, timezone, localDateTime);
  cache.byDayIndex.set(dayIndex, window);
  cache.last = window;
  return window;
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
    return { startMs, endMs, offsetMs, parts };
  }

  const fallbackStartMs = floorToSecondMs(timestampMs);

  return {
    startMs: fallbackStartMs,
    endMs: fallbackStartMs + SECOND_MS,
    offsetMs,
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

/** How far `timezone`'s wall clock is ahead of UTC at `timestampMs`, to the whole second. */
export function resolveOffsetMs(timestampMs: number, timezone: string): number {
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

// Unlike `formatDateKey`, the year keeps its digits: years below 1000 stay unpadded.
function formatLocalDateParts(localDate: LocalDateParts): string {
  return `${localDate.year}-${String(localDate.month).padStart(2, '0')}-${String(localDate.day).padStart(2, '0')}`;
}

/** A local hour bucket: its `YYYY-MM-DD HH:00` key and the UTC offset it was read at. */
export type LocalHourBucket = {
  key: string;
  offsetMs: number;
};

/**
 * The local hour of a timestamp, from the same cached day window as the daily key, so the
 * key's date always equals `getPeriodKey(…, 'daily')`. On a DST fall-back the repeated
 * hour gets one key; `offsetMs` tells its two occurrences apart.
 */
export function getLocalHourBucket(timestampIso: string, timezone: string): LocalHourBucket {
  const timestampMs = parseEventTimestampMs(timestampIso);
  const window = getCachedLocalDateWindow(timestampMs, timezone, timestampIso);

  return { key: getLocalHourKey(window, timestampMs), offsetMs: window.offsetMs };
}

function parseEventTimestampMs(timestampIso: string): number {
  const timestampMs = parseCanonicalTimestampMs(timestampIso) ?? Date.parse(timestampIso);

  if (Number.isNaN(timestampMs)) {
    throw new Error(`Invalid event timestamp: ${timestampIso}`);
  }

  return timestampMs;
}

// One key string per window and hour, so an hourly report does not build a key per event.
function getLocalHourKey(window: LocalDateWindow, timestampMs: number): string {
  const wallClockMs = timestampMs + window.offsetMs;
  const hour = Math.floor((((wallClockMs % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS);
  const hourKeys = (window.hourKeys ??= []);

  return (hourKeys[hour] ??= `${window.parts.dateKey} ${String(hour).padStart(2, '0')}:00`);
}

export function getPeriodKey(
  timestampIso: string,
  granularity: UsageGranularity,
  timezone: string,
): string {
  if (granularity === 'hourly') {
    const timestampMs = parseEventTimestampMs(timestampIso);
    return getLocalHourKey(
      getCachedLocalDateWindow(timestampMs, timezone, timestampIso),
      timestampMs,
    );
  }

  const localDate = extractLocalDateParts(timestampIso, timezone);

  if (granularity === 'daily') {
    return localDate.dateKey;
  }

  if (granularity === 'monthly') {
    return `${localDate.year}-${String(localDate.month).padStart(2, '0')}`;
  }

  return getIsoWeekKey(localDate);
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
  const parts = parseDateKey(localDateKey);

  if (!parts) {
    throw new Error(`Invalid local date key: ${localDateKey}`);
  }

  return getIsoDayOfWeek(parts);
}

export function getCurrentLocalDateKey(timezone: string, now: Date = new Date()): string {
  return extractLocalDateParts(now.toISOString(), timezone).dateKey;
}

const DATE_KEY_GRANULARITY = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
} as const satisfies Record<ReportGranularity, DateKeyGranularity>;

/** Every period key from `first` to `last` (inclusive), including periods without data. */
export function getPeriodKeyRange(
  first: string,
  last: string,
  granularity: ReportGranularity,
): string[] {
  return getDateKeyPeriodRange(first, last, DATE_KEY_GRANULARITY[granularity]);
}
