import { describe, expect, it } from 'vitest';

import {
  computeActiveMs,
  computeUnionActiveMs,
  IDLE_GAP_CAP_MS,
} from '../src/domain/active-time.js';

const MINUTE_MS = 60_000;

describe('computeActiveMs', () => {
  it('returns 0 for empty input', () => {
    expect(computeActiveMs([])).toBe(0);
  });

  it('returns 0 for a single timestamp', () => {
    expect(computeActiveMs([1_000])).toBe(0);
  });

  it('sums a short gap as-is', () => {
    expect(computeActiveMs([0, 3 * MINUTE_MS])).toBe(3 * MINUTE_MS);
  });

  it('caps a long gap at the idle cap', () => {
    expect(computeActiveMs([0, 4 * 60 * MINUTE_MS])).toBe(IDLE_GAP_CAP_MS);
  });

  it('sorts unsorted input before summing', () => {
    expect(computeActiveMs([3 * MINUTE_MS, 0, MINUTE_MS])).toBe(3 * MINUTE_MS);
  });

  it('sums a realistic mixed sequence with per-gap caps', () => {
    // Gaps: 2m, 90m (capped to 5m), 1m => 2m + 5m + 1m.
    const timestamps = [0, 2 * MINUTE_MS, 92 * MINUTE_MS, 93 * MINUTE_MS];

    expect(computeActiveMs(timestamps)).toBe(2 * MINUTE_MS + IDLE_GAP_CAP_MS + MINUTE_MS);
  });
});

describe('computeUnionActiveMs', () => {
  it('counts time two sessions share once', () => {
    // 0-10 and 5-15 MINUTE_MSs, in one-MINUTE_MS steps: 15 MINUTE_MSs of wall clock.
    const steps = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => (from + index) * MINUTE_MS);

    expect(computeUnionActiveMs([steps(0, 10), steps(5, 15)])).toBe(15 * MINUTE_MS);
  });

  it('adds sessions that do not overlap', () => {
    expect(
      computeUnionActiveMs([
        [0, 2 * MINUTE_MS],
        [10 * MINUTE_MS, 13 * MINUTE_MS],
      ]),
    ).toBe(5 * MINUTE_MS);
  });

  it('equals computeActiveMs for one session, idle gaps capped', () => {
    const timestamps = [0, MINUTE_MS, 30 * MINUTE_MS, 31 * MINUTE_MS, 31 * MINUTE_MS];

    expect(computeUnionActiveMs([timestamps])).toBe(computeActiveMs(timestamps));
  });
});
