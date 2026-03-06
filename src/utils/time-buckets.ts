export type ReportGranularity = 'daily' | 'weekly' | 'monthly';

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getDateFormatter(timezone: string): Intl.DateTimeFormat {
  const cachedFormatter = formatterCache.get(timezone);

  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

function extractLocalDateParts(timestampIso: string, timezone: string): LocalDateParts {
  const date = new Date(timestampIso);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid event timestamp: ${timestampIso}`);
  }

  const formatter = getDateFormatter(timezone);
  const parts = formatter.formatToParts(date);

  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);

  if (!year || !month || !day) {
    throw new Error(`Could not resolve local date parts for timestamp: ${timestampIso}`);
  }

  return { year, month, day };
}

function createUtcDate(localDate: LocalDateParts): Date {
  return new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
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
  const weekNumber = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;

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
