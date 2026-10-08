import { describe, expect, it } from 'vitest';

import {
  aggregateDailyActivity,
  calculateCurrentStreak,
  calculateLongestStreak,
  resolveActivityStart,
} from '../../src/aggregate/daily-activity.js';
import { createUsageEvent, type UsageEventInput } from '../../src/domain/usage-event.js';

function event(timestamp: string, overrides: Partial<UsageEventInput> = {}) {
  return createUsageEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp,
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    costMode: 'explicit',
    costUsd: 1,
    ...overrides,
  });
}

describe('calculateCurrentStreak', () => {
  it('counts back from today when today is active', () => {
    const days = new Set(['2026-03-08', '2026-03-09', '2026-03-10']);

    expect(calculateCurrentStreak(days, '2026-03-10')).toBe(3);
  });

  it('keeps the streak alive from yesterday while today has no usage yet', () => {
    const days = new Set(['2026-03-08', '2026-03-09']);

    expect(calculateCurrentStreak(days, '2026-03-10')).toBe(2);
  });

  it('is zero once a full day was missed', () => {
    expect(calculateCurrentStreak(new Set(['2026-03-08']), '2026-03-10')).toBe(0);
    expect(calculateCurrentStreak(new Set(), '2026-03-10')).toBe(0);
  });

  it('crosses month and year boundaries', () => {
    const days = new Set(['2025-12-30', '2025-12-31', '2026-01-01']);

    expect(calculateCurrentStreak(days, '2026-01-01')).toBe(3);
  });
});

describe('calculateLongestStreak', () => {
  it('finds the longest consecutive run', () => {
    expect(calculateLongestStreak(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-05'])).toBe(
      3,
    );
    expect(calculateLongestStreak(['2026-03-05'])).toBe(1);
    expect(calculateLongestStreak([])).toBe(0);
  });
});

describe('resolveActivityStart', () => {
  it('starts on the Monday 52 weeks before the current week', () => {
    // 2026-03-10 is a Tuesday; its week starts Monday 2026-03-09.
    expect(resolveActivityStart('2026-03-10')).toBe('2025-03-10');
    // A Monday maps to the Monday exactly 52 weeks earlier.
    expect(resolveActivityStart('2026-03-09')).toBe('2025-03-10');
    // A Sunday ends its ISO week.
    expect(resolveActivityStart('2026-03-15')).toBe('2025-03-10');
  });
});

describe('aggregateDailyActivity', () => {
  it('buckets days in the report timezone across a DST change', () => {
    // Paris moves to UTC+2 on 2026-03-29: 22:30Z that night is already Mar 30 locally.
    const activity = aggregateDailyActivity(
      [event('2026-03-28T22:30:00.000Z'), event('2026-03-29T22:30:00.000Z')],
      { from: '2026-03-23', to: '2026-03-30', timezone: 'Europe/Paris' },
    );

    expect(activity.days.filter((day) => day.totalTokens > 0).map((day) => day.date)).toEqual([
      '2026-03-28',
      '2026-03-30',
    ]);
    expect(activity.currentStreak).toBe(1);
    expect(activity.longestStreak).toBe(1);
  });

  it('reports streaks, best day, and one heatmap cell per day of the window', () => {
    const activity = aggregateDailyActivity(
      [
        event('2026-03-02T09:00:00.000Z', { totalTokens: 100, costUsd: 2 }),
        event('2026-03-03T09:00:00.000Z', { totalTokens: 900, costUsd: 3 }),
        // Unpriced event: the best day keeps its partial cost and is flagged incomplete.
        event('2026-03-03T10:00:00.000Z', {
          totalTokens: 100,
          costMode: 'estimated',
          costUsd: undefined,
        }),
        event('2026-03-04T09:00:00.000Z', { totalTokens: 50, costUsd: 1 }),
        event('2026-03-09T09:00:00.000Z', { totalTokens: 10, costUsd: 1 }),
        // Outside the window: ignored.
        event('2026-02-28T09:00:00.000Z', { totalTokens: 10_000 }),
      ],
      { from: '2026-03-02', to: '2026-03-10', timezone: 'UTC' },
    );

    expect(activity).toMatchObject({
      from: '2026-03-02',
      to: '2026-03-10',
      activeDays: 4,
      currentStreak: 1,
      longestStreak: 3,
      bestDay: { date: '2026-03-03', totalTokens: 1_000, costUsd: 3, costIncomplete: true },
    });
    expect(activity.days).toHaveLength(9);
    expect(activity.days.map((day) => day.level)).toEqual([3, 4, 2, 0, 0, 0, 0, 1, 0]);
  });

  it('has no best day and no streaks without usage', () => {
    const activity = aggregateDailyActivity([], {
      from: '2026-03-02',
      to: '2026-03-10',
      timezone: 'UTC',
    });

    expect(activity).toMatchObject({ activeDays: 0, currentStreak: 0, longestStreak: 0 });
    expect(activity.bestDay).toBeUndefined();
    expect(activity.days.every((day) => day.level === 0)).toBe(true);
  });
});
