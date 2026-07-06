import { describe, expect, it } from 'vitest';

import { createUsageEvent, type UsageEventInput } from '../../src/domain/usage-event.js';
import { aggregateSessions } from '../../src/session/aggregate-sessions.js';

function event(input: UsageEventInput) {
  return createUsageEvent(input);
}

describe('aggregateSessions', () => {
  it('groups events by source and session id and sums usage buckets', () => {
    const rows = aggregateSessions([
      event({
        source: 'codex',
        sessionId: 'same-session',
        timestamp: '2026-01-02T10:00:00.000Z',
        model: 'GPT-5',
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        costUsd: 0.12,
      }),
      event({
        source: 'codex',
        sessionId: 'same-session',
        timestamp: '2026-01-02T10:05:00.000Z',
        model: 'gpt-4.1',
        inputTokens: 20,
        outputTokens: 6,
        reasoningTokens: 1,
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
        costUsd: 0.08,
      }),
      event({
        source: 'pi',
        sessionId: 'same-session',
        timestamp: '2026-01-02T10:03:00.000Z',
        inputTokens: 1,
        outputTokens: 2,
        costUsd: 0.01,
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rowType: 'session',
      source: 'codex',
      sessionId: 'same-session',
      firstActivity: '2026-01-02T10:00:00.000Z',
      lastActivity: '2026-01-02T10:05:00.000Z',
      eventCount: 2,
      models: ['gpt-4.1', 'gpt-5'],
      inputTokens: 30,
      outputTokens: 11,
      reasoningTokens: 3,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
      totalTokens: 54,
      costUsd: 0.2,
    });
    expect(rows[1]).toMatchObject({
      source: 'pi',
      sessionId: 'same-session',
      eventCount: 1,
      totalTokens: 3,
      costUsd: 0.01,
    });
  });

  it('sorts by cost desc, undefined costs last, last activity desc, then session id', () => {
    const rows = aggregateSessions([
      event({
        source: 'codex',
        sessionId: 'undefined-cost-newer',
        timestamp: '2026-01-02T11:00:00.000Z',
        inputTokens: 1,
      }),
      event({
        source: 'codex',
        sessionId: 'cost-a',
        timestamp: '2026-01-02T09:00:00.000Z',
        inputTokens: 1,
        costUsd: 2,
      }),
      event({
        source: 'codex',
        sessionId: 'cost-b',
        timestamp: '2026-01-02T12:00:00.000Z',
        inputTokens: 1,
        costUsd: 2,
      }),
      event({
        source: 'codex',
        sessionId: 'cost-c',
        timestamp: '2026-01-02T12:00:00.000Z',
        inputTokens: 1,
        costUsd: 2,
      }),
      event({
        source: 'codex',
        sessionId: 'highest-cost',
        timestamp: '2026-01-02T08:00:00.000Z',
        inputTokens: 1,
        costUsd: 3,
      }),
    ]);

    expect(rows.map((row) => row.sessionId)).toEqual([
      'highest-cost',
      'cost-b',
      'cost-c',
      'cost-a',
      'undefined-cost-newer',
    ]);
    expect(rows.at(-1)?.costUsd).toBeUndefined();
    expect(rows.at(-1)?.costIncomplete).toBe(true);
  });

  it('keeps only the requested top rows after sorting', () => {
    const rows = aggregateSessions(
      [
        event({
          source: 'codex',
          sessionId: 'one',
          timestamp: '2026-01-02T10:00:00.000Z',
          inputTokens: 1,
          costUsd: 1,
        }),
        event({
          source: 'codex',
          sessionId: 'two',
          timestamp: '2026-01-02T10:00:00.000Z',
          inputTokens: 1,
          costUsd: 2,
        }),
        event({
          source: 'codex',
          sessionId: 'three',
          timestamp: '2026-01-02T10:00:00.000Z',
          inputTokens: 1,
          costUsd: 3,
        }),
      ],
      { top: 2 },
    );

    expect(rows.map((row) => row.sessionId)).toEqual(['three', 'two']);
  });

  it('marks partially priced and unpriced sessions as cost incomplete', () => {
    const rows = aggregateSessions([
      event({
        source: 'codex',
        sessionId: 'partial',
        timestamp: '2026-01-02T10:00:00.000Z',
        inputTokens: 1,
        costUsd: 0.1,
      }),
      event({
        source: 'codex',
        sessionId: 'partial',
        timestamp: '2026-01-02T10:01:00.000Z',
        inputTokens: 1,
      }),
      event({
        source: 'codex',
        sessionId: 'none',
        timestamp: '2026-01-02T10:02:00.000Z',
        inputTokens: 1,
      }),
    ]);

    expect(rows.find((row) => row.sessionId === 'partial')).toMatchObject({
      costUsd: 0.1,
      costIncomplete: true,
    });
    expect(rows.find((row) => row.sessionId === 'none')).toMatchObject({
      costUsd: undefined,
      costIncomplete: true,
    });
  });

  it('filters events by local date before grouping', () => {
    const rows = aggregateSessions(
      [
        event({
          source: 'codex',
          sessionId: 'boundary',
          timestamp: '2026-01-01T23:30:00.000Z',
          inputTokens: 100,
          costUsd: 1,
        }),
        event({
          source: 'codex',
          sessionId: 'boundary',
          timestamp: '2026-01-02T10:00:00.000Z',
          inputTokens: 10,
          costUsd: 0.1,
        }),
        event({
          source: 'codex',
          sessionId: 'boundary',
          timestamp: '2026-01-03T01:00:00.000Z',
          inputTokens: 100,
          costUsd: 1,
        }),
      ],
      {
        timezone: 'UTC',
        since: '2026-01-02',
        until: '2026-01-02',
      },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: 'boundary',
      firstActivity: '2026-01-02T10:00:00.000Z',
      lastActivity: '2026-01-02T10:00:00.000Z',
      eventCount: 1,
      inputTokens: 10,
      costUsd: 0.1,
    });
  });
});
