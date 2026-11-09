// The one definition of active time. A gap between consecutive events of a session counts in
// full up to IDLE_GAP_CAP_MS and not at all beyond it: past the cap the user stepped away.

/** The longest gap between two events of a session that still counts as activity. */
export const IDLE_GAP_CAP_MS = 5 * 60 * 1000;

/** The active time between two consecutive events: the whole gap, or 0 past the cap. */
export function getActiveGapMs(earlierMs: number, laterMs: number): number {
  const gapMs = laterMs - earlierMs;
  return gapMs <= IDLE_GAP_CAP_MS ? gapMs : 0;
}

/**
 * The stretches of time when at least one list (session) was active, oldest first, disjoint
 * and not touching: parallel sessions merge into one stretch.
 */
export function computeActiveIntervals(
  timestampLists: Iterable<readonly number[]>,
): [start: number, end: number][] {
  const intervals: [number, number][] = [];

  for (const timestamps of timestampLists) {
    const sorted = [...timestamps].sort((left, right) => left - right);

    for (let index = 1; index < sorted.length; index += 1) {
      if (getActiveGapMs(sorted[index - 1], sorted[index]) > 0) {
        intervals.push([sorted[index - 1], sorted[index]]);
      }
    }
  }

  intervals.sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];

  for (const [start, end] of intervals) {
    const last = merged.at(-1);

    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  return merged;
}

/** Wall-clock active time across several lists (sessions): overlapping time counts once. */
export function computeUnionActiveMs(timestampLists: Iterable<readonly number[]>): number {
  return computeActiveIntervals(timestampLists).reduce(
    (total, [start, end]) => total + end - start,
    0,
  );
}

/** Active time of one session. Zero for empty or single-timestamp input. */
export function computeActiveMs(timestampsMs: readonly number[]): number {
  return computeUnionActiveMs([timestampsMs]);
}
