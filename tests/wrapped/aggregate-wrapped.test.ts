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
      totalCostUsd: 6,
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

    expect(recap.topModels.map((item) => item.name)).toEqual(['model-a', 'model-b', 'model-d']);
    expect(recap.topSources.map((item) => item.name)).toEqual(['codex', 'pi', 'droid']);
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

    expect(recap.topModels.map((item) => item.name)).toEqual(['large', 'middle', 'small']);
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
