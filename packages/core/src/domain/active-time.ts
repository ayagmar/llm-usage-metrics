/** Cap for inter-event gaps when summing active time. A gap longer than
 *  this counts as this much (the user stepped away, not "8 hours of AI"). */
export const IDLE_GAP_CAP_MS = 5 * 60 * 1000;

/** Sum of consecutive-event gaps, each capped at IDLE_GAP_CAP_MS.
 *  Zero for empty or single-timestamp input. */
export function computeActiveMs(timestampsMs: readonly number[]): number {
  const sorted = [...timestampsMs].sort((left, right) => left - right);
  let activeMs = 0;

  for (let index = 1; index < sorted.length; index += 1) {
    activeMs += Math.min(sorted[index] - sorted[index - 1], IDLE_GAP_CAP_MS);
  }

  return activeMs;
}

/** Wall-clock active time across several timestamp lists (sessions): each list's
 *  consecutive-event gaps, capped at IDLE_GAP_CAP_MS, become intervals, and time
 *  covered by more than one list counts once. Equals computeActiveMs for one list. */
export function computeUnionActiveMs(timestampLists: Iterable<readonly number[]>): number {
  const intervals: [number, number][] = [];

  for (const timestamps of timestampLists) {
    const sorted = [...timestamps].sort((left, right) => left - right);

    for (let index = 1; index < sorted.length; index += 1) {
      const start = sorted[index - 1];
      const end = Math.min(sorted[index], start + IDLE_GAP_CAP_MS);

      if (end > start) {
        intervals.push([start, end]);
      }
    }
  }

  intervals.sort((left, right) => left[0] - right[0]);
  let activeMs = 0;
  let coveredUntil = Number.NEGATIVE_INFINITY;

  for (const [start, end] of intervals) {
    if (end > coveredUntil) {
      activeMs += end - Math.max(start, coveredUntil);
      coveredUntil = end;
    }
  }

  return activeMs;
}
