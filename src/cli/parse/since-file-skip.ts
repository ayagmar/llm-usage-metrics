const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Files whose newest mtime is before this instant cannot hold events on or after `since`
 * in any timezone: accepted zones are at most +23:59 ahead of UTC, so local midnight is
 * less than one day before UTC midnight. `since` is a validated YYYY-MM-DD date.
 */
export function getSinceFileSkipCutoffMs(since: string | undefined): number | undefined {
  if (!since) {
    return undefined;
  }

  const sinceUtcMidnightMs = Date.parse(`${since}T00:00:00.000Z`);
  return Number.isFinite(sinceUtcMidnightMs) ? sinceUtcMidnightMs - DAY_MS : undefined;
}
