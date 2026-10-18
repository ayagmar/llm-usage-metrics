import { getCurrentLocalDateKey, resolveOffsetMs } from '../utils/time-buckets.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The first instant whose local date in `timezone` is `dateKey` (YYYY-MM-DD): local
 * midnight, or the end of a DST gap that skips midnight.
 */
export function getLocalDayStartMs(dateKey: string, timezone: string): number {
  const utcMidnightMs = Date.parse(`${dateKey}T00:00:00.000Z`);
  let startMs = utcMidnightMs - resolveOffsetMs(utcMidnightMs, timezone);
  startMs = utcMidnightMs - resolveOffsetMs(startMs, timezone);

  // Where midnight does not exist, the day starts at the end of the gap, on an hour.
  while (getCurrentLocalDateKey(timezone, new Date(startMs)) < dateKey) {
    startMs += HOUR_MS;
  }

  while (getCurrentLocalDateKey(timezone, new Date(startMs - HOUR_MS)) >= dateKey) {
    startMs -= HOUR_MS;
  }

  return startMs;
}
