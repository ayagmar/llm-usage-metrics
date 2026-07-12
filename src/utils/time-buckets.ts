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

type LocalDateWindow = {
  startMs: number;
  endMs: number;
  parts: LocalDateParts;
};

type LocalDateWindowCache = {
  last: LocalDateWindow | undefined;
  byDayIndex: Map<number, LocalDateWindow>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
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

function extractLocalDateParts(timestampIso: string, timezone: string): LocalDateParts {
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
): LocalDateParts {
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
  const parts = toLocalDateParts(localDateTime);

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
    return formatLocalDateParts(localDate);
  }

  if (granularity === 'monthly') {
    return `${localDate.year}-${String(localDate.month).padStart(2, '0')}`;
  }

  const isoWeek = getIsoWeekParts(localDate);
  return `${isoWeek.weekYear}-W${String(isoWeek.weekNumber).padStart(2, '0')}`;
}

export function getLocalDateKey(timestampIso: string, timezone: string): string {
  return formatLocalDateParts(extractLocalDateParts(timestampIso, timezone));
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
  return formatLocalDateParts(extractLocalDateParts(now.toISOString(), timezone));
}

export function shiftLocalDateKey(localDateKey: string, days: number): string {
  return formatLocalDateParts(
    extractLocalDateParts(
      addDays(createUtcDate(parseLocalDateKey(localDateKey)), days).toISOString(),
      'UTC',
    ),
  );
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
