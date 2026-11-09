import { describe, expect, it } from 'vitest';

import {
  computeActiveMs,
  computeUnionActiveMs,
  IDLE_GAP_CAP_MS,
} from '../src/domain/active-time.js';
import { computeActiveIntervals } from '../src/internal/index.js';

const MINUTE_MS = 60 * 1000;
const steps = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, offset) => (from + offset) * MINUTE_MS);

describe('computeActiveMs', () => {
  it.each([
    ['no events', [], 0],
    ['one event', [1_000], 0],
    ['a gap below the cap', [0, IDLE_GAP_CAP_MS - 1], IDLE_GAP_CAP_MS - 1],
    ['a gap exactly at the cap', [0, IDLE_GAP_CAP_MS], IDLE_GAP_CAP_MS],
    ['a gap just over the cap', [0, IDLE_GAP_CAP_MS + 1], 0],
    ['a long idle gap', [0, 240 * MINUTE_MS], 0],
    ['duplicate timestamps', [MINUTE_MS, MINUTE_MS, 2 * MINUTE_MS], MINUTE_MS],
    ['unsorted input', [3 * MINUTE_MS, 0, MINUTE_MS], 3 * MINUTE_MS],
  ])('counts %s', (_name, timestamps, expected) => {
    expect(computeActiveMs(timestamps)).toBe(expected);
  });

  it('drops only the idle gap between two bursts', () => {
    expect(computeActiveMs([...steps(0, 2), ...steps(60, 61)])).toBe(3 * MINUTE_MS);
  });
});

describe('computeUnionActiveMs', () => {
  it('counts two fully overlapping sessions once', () => {
    expect(computeUnionActiveMs([steps(0, 10), steps(0, 10)])).toBe(10 * MINUTE_MS);
  });

  it('counts a partial overlap once', () => {
    expect(computeUnionActiveMs([steps(0, 10), steps(5, 15)])).toBe(15 * MINUTE_MS);
  });

  it('adds sessions that do not overlap', () => {
    expect(computeUnionActiveMs([steps(0, 5), steps(30, 35)])).toBe(10 * MINUTE_MS);
  });

  it('does not count the idle gap of one session as overlap with another', () => {
    const parked = [0, 60 * MINUTE_MS];

    expect(computeUnionActiveMs([parked, steps(10, 20)])).toBe(10 * MINUTE_MS);
  });

  it('is zero for no sessions', () => {
    expect(computeUnionActiveMs([])).toBe(0);
  });
});

describe('active time invariants', () => {
  // A small seeded generator: the sequences stay reproducible when a run fails.
  function randomSessions(seed: number): number[][] {
    let state = seed;
    const next = (limit: number) => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state % limit;
    };

    return Array.from({ length: next(6) }, () =>
      Array.from({ length: next(30) }, () => next(600) * 15_000),
    );
  }

  it('holds wall-clock under Agent time, and intervals to the union, on generated sessions', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const sessions = randomSessions(seed);
      const agentMs = sessions.reduce((total, list) => total + computeActiveMs(list), 0);
      const activeMs = computeUnionActiveMs(sessions);
      const intervals = computeActiveIntervals(sessions);

      expect(activeMs).toBeLessThanOrEqual(agentMs);
      expect(activeMs).toBeGreaterThanOrEqual(
        Math.max(0, ...sessions.map((list) => computeActiveMs(list))),
      );
      expect(intervals.reduce((total, [start, end]) => total + end - start, 0)).toBe(activeMs);

      for (const [index, [start, end]] of intervals.entries()) {
        expect(end).toBeGreaterThan(start);
        expect(start).toBeGreaterThan(intervals[index - 1]?.[1] ?? Number.NEGATIVE_INFINITY);
      }
    }
  });
});
