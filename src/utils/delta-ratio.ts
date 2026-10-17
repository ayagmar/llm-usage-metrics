/**
 * The change from `baseline` to `current` as a ratio of the baseline: `0.5` is 50% more. Zero
 * when both are zero, undefined when either is unknown or only the baseline is zero. Shared by
 * `compare` and the share report's summary lead, so both word a change the same way.
 */
export function computeDeltaRatio(
  current: number | undefined,
  baseline: number | undefined,
): number | undefined {
  if (current === undefined || baseline === undefined) {
    return undefined;
  }

  if (baseline === 0) {
    return current === 0 ? 0 : undefined;
  }

  return (current - baseline) / baseline;
}
