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
