import { describe, expect, it } from 'vitest';

import { createUsageEvent, type UsageEventInput } from '../../src/domain/usage-event.js';
import { aggregateWrapped } from '../../src/wrapped/aggregate-wrapped.js';

function event(input: UsageEventInput) {
  return createUsageEvent(input);
}

function baseEvent(overrides: Partial<UsageEventInput> = {}) {
  return event({
    source: 'pi',
    sessionId: 'session-1',
    timestamp: '2026-01-01T10:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    costMode: 'estimated',
    ...overrides,
  });
}

describe('aggregateWrapped', () => {
  it('computes active time, peak hour, weekday split, and busiest day', () => {
    const recap = aggregateWrapped(
      [
        // Session s-a on Monday 2026-01-05: gaps 3m + 90m (capped at 5m) = 8m.
        baseEvent({
          sessionId: 's-a',
          timestamp: '2026-01-05T10:00:00.000Z',
          totalTokens: 100,
          costUsd: 1,
        }),
        baseEvent({
          sessionId: 's-a',
          timestamp: '2026-01-05T10:03:00.000Z',
          totalTokens: 50,
          costUsd: 2,
        }),
        baseEvent({
          sessionId: 's-a',
          timestamp: '2026-01-05T11:33:00.000Z',
          totalTokens: 100,
          costUsd: 3,
        }),
        // Single-event session s-b on Saturday 2026-01-10 contributes 0 active ms.
        baseEvent({
          sessionId: 's-b',
          timestamp: '2026-01-10T22:00:00.000Z',
          totalTokens: 150,
          costUsd: 4,
        }),
      ],
      { year: 2026, timezone: 'UTC' },
    );

    expect(recap.activeMs).toBe(8 * 60 * 1000);
    // Hours 10 and 22 tie at 150 tokens; the lowest hour wins.
    expect(recap.peakHour).toEqual({ hour: 10, totalTokens: 150 });
    expect(recap.weekdayTokens).toBe(250);
    expect(recap.weekendTokens).toBe(150);
    expect(recap.busiestDay).toEqual({
      date: '2026-01-05',
      totalTokens: 250,
      costUsd: 6,
      costIncomplete: undefined,
    });
  });

  it('leaves time stats empty for an empty year', () => {
    const recap = aggregateWrapped([], { year: 2026, timezone: 'UTC' });

    expect(recap.activeMs).toBe(0);
    expect(recap.peakHour).toBeUndefined();
    expect(recap.busiestDay).toBeUndefined();
    expect(recap.weekdayTokens).toBe(0);
    expect(recap.weekendTokens).toBe(0);
  });

  it('filters to the local year and computes active days, sessions, totals, and streaks', () => {
    const recap = aggregateWrapped(
      [
        baseEvent({
          sessionId: 'previous-year',
          timestamp: '2025-12-31T10:00:00.000Z',
          totalTokens: 1_000,
          costUsd: 10,
        }),
        baseEvent({
          sessionId: 'session-1',
          timestamp: '2026-01-01T10:00:00.000Z',
          totalTokens: 100,
          costUsd: 1,
        }),
        baseEvent({
          sessionId: 'session-1',
          timestamp: '2026-01-02T10:00:00.000Z',
          totalTokens: 200,
          costUsd: 2,
        }),
        baseEvent({
          source: 'codex',
          sessionId: 'session-2',
          timestamp: '2026-01-04T10:00:00.000Z',
          totalTokens: 300,
          costUsd: 3,
        }),
        baseEvent({
          sessionId: 'next-year',
          timestamp: '2027-01-01T10:00:00.000Z',
          totalTokens: 1_000,
          costUsd: 10,
        }),
      ],
      { year: 2026, timezone: 'UTC' },
    );

    expect(recap).toMatchObject({
      year: 2026,
      from: '2026-01-01',
      to: '2026-12-31',
      totalTokens: 600,
      costUsd: 6,
      activeDays: 3,
      longestStreak: 2,
      eventCount: 3,
      sessionCount: 2,
    });
  });

  it('uses a one-day streak for a single active day', () => {
    const recap = aggregateWrapped([baseEvent()], { year: 2026, timezone: 'UTC' });

    expect(recap.activeDays).toBe(1);
    expect(recap.longestStreak).toBe(1);
  });

  it('counts consecutive days across a month boundary as one streak', () => {
    const recap = aggregateWrapped(
      [
        baseEvent({ timestamp: '2026-01-30T10:00:00.000Z' }),
        baseEvent({ timestamp: '2026-01-31T10:00:00.000Z' }),
        baseEvent({ timestamp: '2026-02-01T10:00:00.000Z' }),
        baseEvent({ timestamp: '2026-02-02T10:00:00.000Z' }),
      ],
      { year: 2026, timezone: 'UTC' },
    );

    expect(recap.activeDays).toBe(4);
    expect(recap.longestStreak).toBe(4);
  });

  it('sorts top models and sources by cost, then tokens, then name', () => {
    const recap = aggregateWrapped(
      [
        baseEvent({
          source: 'pi',
          sessionId: 'a',
          model: 'model-b',
          totalTokens: 100,
          costUsd: 5,
        }),
        baseEvent({
          source: 'codex',
          sessionId: 'b',
          model: 'model-a',
          totalTokens: 200,
          costUsd: 5,
        }),
        baseEvent({
          source: 'gemini',
          sessionId: 'c',
          model: 'model-c',
          totalTokens: 1_000,
        }),
        baseEvent({
          source: 'droid',
          sessionId: 'd',
          model: 'model-d',
          totalTokens: 10,
          costUsd: 1,
        }),
      ],
      { year: 2026, timezone: 'UTC' },
    );

    expect(recap.topModels.map((item) => item.name)).toEqual([
      'model-a',
      'model-b',
      'model-d',
      'model-c',
    ]);
    expect(recap.topSources.map((item) => item.name)).toEqual(['codex', 'pi', 'droid', 'gemini']);
    expect(recap.costIncomplete).toBe(true);
  });

  it('falls back to tokens for unpriced top-item ties', () => {
    const recap = aggregateWrapped(
      [
        baseEvent({ model: 'small', totalTokens: 100 }),
        baseEvent({ model: 'large', totalTokens: 300 }),
        baseEvent({ model: 'middle', totalTokens: 200 }),
        baseEvent({ model: 'excluded', totalTokens: 50 }),
      ],
      { year: 2026, timezone: 'UTC' },
    );

    expect(recap.topModels.map((item) => item.name)).toEqual([
      'large',
      'middle',
      'small',
      'excluded',
    ]);
  });

  it('caps top models and sources at five entries', () => {
    const recap = aggregateWrapped(
      Array.from({ length: 6 }, (_, index) =>
        baseEvent({
          source: `source-${index}`,
          sessionId: `session-${index}`,
          model: `model-${index}`,
          totalTokens: (index + 1) * 100,
          costUsd: index + 1,
        }),
      ),
      { year: 2026, timezone: 'UTC' },
    );

    expect(recap.topModels).toHaveLength(5);
    expect(recap.topSources).toHaveLength(5);
    expect(recap.topModels.map((item) => item.name)).toEqual([
      'model-5',
      'model-4',
      'model-3',
      'model-2',
      'model-1',
    ]);
  });

  it('builds twelve all-zero monthly intensity buckets for an empty year', () => {
    const recap = aggregateWrapped([], { year: 2026, timezone: 'UTC' });

    expect(recap.monthlyIntensity).toHaveLength(12);
    expect(recap.monthlyIntensity[0]).toEqual({
      month: '2026-01',
      totalTokens: 0,
      costUsd: undefined,
      costIncomplete: undefined,
      level: 0,
    });
    expect(recap.monthlyIntensity.at(-1)).toMatchObject({
      month: '2026-12',
      totalTokens: 0,
      level: 0,
    });
    expect(recap.activeDays).toBe(0);
    expect(recap.longestStreak).toBe(0);
  });

  it('builds one all-zero daily intensity bucket per day for an empty year', () => {
    const recap = aggregateWrapped([], { year: 2026, timezone: 'UTC' });

    expect(recap.dailyIntensity).toHaveLength(365);
    expect(recap.dailyIntensity[0]).toEqual({ date: '2026-01-01', totalTokens: 0, level: 0 });
    expect(recap.dailyIntensity.at(-1)).toEqual({ date: '2026-12-31', totalTokens: 0, level: 0 });
  });

  it('covers leap years with 366 daily intensity buckets', () => {
    const recap = aggregateWrapped([], { year: 2028, timezone: 'UTC' });

    expect(recap.dailyIntensity).toHaveLength(366);
    expect(recap.dailyIntensity[59]).toEqual({ date: '2028-02-29', totalTokens: 0, level: 0 });
  });

  it('bands daily intensity levels by quartile of the active days', () => {
    const recap = aggregateWrapped(
      [
        baseEvent({ timestamp: '2026-01-01T10:00:00.000Z', totalTokens: 25 }),
        baseEvent({ timestamp: '2026-01-02T10:00:00.000Z', totalTokens: 50 }),
        baseEvent({ timestamp: '2026-01-03T10:00:00.000Z', totalTokens: 100 }),
      ],
      { year: 2026, timezone: 'UTC' },
    );

    expect(recap.dailyIntensity.slice(0, 4).map((day) => day.level)).toEqual([1, 2, 4, 0]);
    expect(recap.dailyIntensity[2]).toEqual({ date: '2026-01-03', totalTokens: 100, level: 4 });
  });

  it('keeps quartile banding stable when one outlier day dwarfs the rest', () => {
    const typicalDays = Array.from({ length: 8 }, (_, index) =>
      baseEvent({
        timestamp: `2026-01-0${index + 1}T10:00:00.000Z`,
        totalTokens: 100 + index,
      }),
    );
    const recap = aggregateWrapped(
      [
        ...typicalDays,
        baseEvent({ timestamp: '2026-01-09T10:00:00.000Z', totalTokens: 1_000_000 }),
      ],
      { year: 2026, timezone: 'UTC' },
    );
    const levels = recap.dailyIntensity.slice(0, 9).map((day) => day.level);

    expect(new Set(levels).size).toBeGreaterThan(2);
    expect(levels.at(-1)).toBe(4);
  });

  it('scales monthly intensity levels against the busiest month', () => {
    const recap = aggregateWrapped(
      [
        baseEvent({ timestamp: '2026-01-01T10:00:00.000Z', totalTokens: 25 }),
        baseEvent({ timestamp: '2026-02-01T10:00:00.000Z', totalTokens: 50 }),
        baseEvent({ timestamp: '2026-03-01T10:00:00.000Z', totalTokens: 100 }),
      ],
      { year: 2026, timezone: 'UTC' },
    );

    expect(recap.monthlyIntensity.slice(0, 4).map((month) => month.level)).toEqual([1, 2, 4, 0]);
  });

  it('attributes year membership by the requested timezone', () => {
    const recap = aggregateWrapped(
      [
        baseEvent({
          sessionId: 'local-previous-year',
          timestamp: '2026-01-01T02:00:00.000Z',
          totalTokens: 100,
        }),
        baseEvent({
          sessionId: 'local-current-year',
          timestamp: '2026-01-01T05:00:00.000Z',
          totalTokens: 200,
        }),
      ],
      { year: 2026, timezone: 'America/New_York' },
    );

    expect(recap.totalTokens).toBe(200);
    expect(recap.sessionCount).toBe(1);
    expect(recap.monthlyIntensity[0]?.totalTokens).toBe(200);
  });
});
