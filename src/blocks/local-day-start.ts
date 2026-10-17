import { getCurrentLocalDateKey } from '../utils/time-buckets.js';

const HOUR_MS = 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timezone, formatter);
  }

  return formatter;
}

/** How far `timezone`'s wall clock is ahead of UTC at `instantMs`. */
function getUtcOffsetMs(timezone: string, instantMs: number): number {
  const parts = Object.fromEntries(
    getFormatter(timezone)
      .formatToParts(new Date(instantMs))
      .map((part) => [part.type, Number(part.value)]),
  );
  const wallClockMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  // The wall clock has whole seconds; compare it with the instant's whole second.
  return wallClockMs - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The first instant whose local date in `timezone` is `dateKey` (YYYY-MM-DD): local
 * midnight, or the end of a DST gap that skips midnight.
 */
export function getLocalDayStartMs(dateKey: string, timezone: string): number {
  const utcMidnightMs = Date.parse(`${dateKey}T00:00:00.000Z`);
  let startMs = utcMidnightMs - getUtcOffsetMs(timezone, utcMidnightMs);
  startMs = utcMidnightMs - getUtcOffsetMs(timezone, startMs);

  // Where midnight does not exist, the day starts at the end of the gap, on an hour.
  while (getCurrentLocalDateKey(timezone, new Date(startMs)) < dateKey) {
    startMs += HOUR_MS;
  }

  while (getCurrentLocalDateKey(timezone, new Date(startMs - HOUR_MS)) >= dateKey) {
    startMs -= HOUR_MS;
  }

  return startMs;
}
