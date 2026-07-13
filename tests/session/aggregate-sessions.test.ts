import { describe, expect, it } from 'vitest';

import { IDLE_GAP_CAP_MS } from '../../src/domain/active-time.js';
import { createUsageEvent, type UsageEventInput } from '../../src/domain/usage-event.js';
import {
  aggregateSessions,
  aggregateSessionsByRepo,
} from '../../src/session/aggregate-sessions.js';

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

  it('computes raw duration and gap-capped active time per session', () => {
    // Events at 10:00, 10:30 (30m gap, capped to 5m), 12:00 (90m gap, capped
    // to 5m): durationMs = 2h, activeMs = 2 * IDLE_GAP_CAP_MS.
    const rows = aggregateSessions([
      event({
        source: 'codex',
        sessionId: 'timed-session',
        timestamp: '2026-01-02T10:00:00.000Z',
        inputTokens: 1,
        outputTokens: 1,
      }),
      event({
        source: 'codex',
        sessionId: 'timed-session',
        timestamp: '2026-01-02T10:30:00.000Z',
        inputTokens: 1,
        outputTokens: 1,
      }),
      event({
        source: 'codex',
        sessionId: 'timed-session',
        timestamp: '2026-01-02T12:00:00.000Z',
        inputTokens: 1,
        outputTokens: 1,
      }),
      event({
        source: 'pi',
        sessionId: 'single-event',
        timestamp: '2026-01-02T09:00:00.000Z',
        inputTokens: 1,
        outputTokens: 1,
      }),
    ]);

    const timedRow = rows.find((row) => row.sessionId === 'timed-session');
    const singleRow = rows.find((row) => row.sessionId === 'single-event');

    expect(timedRow).toMatchObject({
      durationMs: 2 * 60 * 60 * 1000,
      activeMs: 2 * IDLE_GAP_CAP_MS,
    });
    expect(singleRow).toMatchObject({ durationMs: 0, activeMs: 0 });
  });

  it('sums short gaps as-is inside active time', () => {
    // Gaps: 3m + 90m (capped to 5m) = 8m active over a 93m duration.
    const rows = aggregateSessions([
      event({
        source: 'codex',
        sessionId: 'mixed-gaps',
        timestamp: '2026-01-02T10:00:00.000Z',
        inputTokens: 1,
        outputTokens: 1,
      }),
      event({
        source: 'codex',
        sessionId: 'mixed-gaps',
        timestamp: '2026-01-02T10:03:00.000Z',
        inputTokens: 1,
        outputTokens: 1,
      }),
      event({
        source: 'codex',
        sessionId: 'mixed-gaps',
        timestamp: '2026-01-02T11:33:00.000Z',
        inputTokens: 1,
        outputTokens: 1,
      }),
    ]);

    expect(rows[0]).toMatchObject({
      durationMs: 93 * 60 * 1000,
      activeMs: 3 * 60 * 1000 + IDLE_GAP_CAP_MS,
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

  it('attributes the first seen repo root to the session row', () => {
    const rows = aggregateSessions([
      event({
        source: 'codex',
        sessionId: 'with-repo',
        timestamp: '2026-01-02T10:00:00.000Z',
        inputTokens: 1,
        costUsd: 2,
      }),
      event({
        source: 'codex',
        sessionId: 'with-repo',
        timestamp: '2026-01-02T10:01:00.000Z',
        inputTokens: 1,
        costUsd: 2,
        repoRoot: '/home/user/project-a',
      }),
      event({
        source: 'codex',
        sessionId: 'with-repo',
        timestamp: '2026-01-02T10:02:00.000Z',
        inputTokens: 1,
        costUsd: 2,
        repoRoot: '/home/user/project-b',
      }),
      event({
        source: 'codex',
        sessionId: 'without-repo',
        timestamp: '2026-01-02T10:03:00.000Z',
        inputTokens: 1,
        costUsd: 1,
      }),
    ]);

    expect(rows.find((row) => row.sessionId === 'with-repo')?.repoRoot).toBe(
      '/home/user/project-a',
    );
    expect(rows.find((row) => row.sessionId === 'without-repo')?.repoRoot).toBeUndefined();
  });

  it('filters sessions by case-insensitive id substrings before grouping', () => {
    const events = [
      event({
        source: 'codex',
        sessionId: 'Alpha-Session-486C',
        timestamp: '2026-01-02T10:00:00.000Z',
        inputTokens: 1,
        costUsd: 1,
      }),
      event({
        source: 'codex',
        sessionId: 'beta-session',
        timestamp: '2026-01-02T10:01:00.000Z',
        inputTokens: 1,
        costUsd: 2,
      }),
      event({
        source: 'codex',
        sessionId: 'gamma',
        timestamp: '2026-01-02T10:02:00.000Z',
        inputTokens: 1,
        costUsd: 3,
      }),
    ];

    expect(aggregateSessions(events, { ids: ['486c'] }).map((row) => row.sessionId)).toEqual([
      'Alpha-Session-486C',
    ]);
    expect(
      aggregateSessions(events, { ids: ['486C', 'BETA'] }).map((row) => row.sessionId),
    ).toEqual(['beta-session', 'Alpha-Session-486C']);
    expect(aggregateSessions(events, { ids: ['no-such-id'] })).toEqual([]);
  });
});

describe('aggregateSessionsByRepo', () => {
  it('groups events by repo root with a no-repo bucket and distinct session counts', () => {
    const rows = aggregateSessionsByRepo([
      event({
        source: 'codex',
        sessionId: 'shared-id',
        timestamp: '2026-01-02T10:00:00.000Z',
        model: 'gpt-5',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.5,
        repoRoot: '/home/user/project-a',
      }),
      event({
        source: 'pi',
        sessionId: 'shared-id',
        timestamp: '2026-01-02T11:00:00.000Z',
        inputTokens: 20,
        outputTokens: 10,
        costUsd: 0.25,
        repoRoot: '/home/user/project-a',
      }),
      event({
        source: 'pi',
        sessionId: 'shared-id',
        timestamp: '2026-01-02T12:00:00.000Z',
        inputTokens: 5,
        outputTokens: 5,
        costUsd: 0.25,
        repoRoot: '/home/user/project-a',
      }),
      event({
        source: 'claude',
        sessionId: 'orphan',
        timestamp: '2026-01-02T09:00:00.000Z',
        inputTokens: 3,
        outputTokens: 1,
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rowType: 'repo',
      repoRoot: '/home/user/project-a',
      sessionCount: 2,
      firstActivity: '2026-01-02T10:00:00.000Z',
      lastActivity: '2026-01-02T12:00:00.000Z',
      sources: ['codex', 'pi'],
      inputTokens: 35,
      outputTokens: 20,
      totalTokens: 55,
      costUsd: 1,
    });
    expect(rows[1]).toMatchObject({
      rowType: 'repo',
      repoRoot: undefined,
      sessionCount: 1,
      sources: ['claude'],
      costUsd: undefined,
      costIncomplete: true,
    });
  });

  it('sorts repo rows by cost desc, undefined cost last, activity desc, then repo path', () => {
    const rows = aggregateSessionsByRepo([
      event({
        source: 'codex',
        sessionId: 'a',
        timestamp: '2026-01-02T10:00:00.000Z',
        inputTokens: 1,
        costUsd: 1,
        repoRoot: '/repo/cheap',
      }),
      event({
        source: 'codex',
        sessionId: 'b',
        timestamp: '2026-01-02T10:00:00.000Z',
        inputTokens: 1,
        costUsd: 2,
        repoRoot: '/repo/tie-b',
      }),
      event({
        source: 'codex',
        sessionId: 'c',
        timestamp: '2026-01-02T10:00:00.000Z',
        inputTokens: 1,
        costUsd: 2,
        repoRoot: '/repo/tie-a',
      }),
      event({
        source: 'codex',
        sessionId: 'd',
        timestamp: '2026-01-02T11:00:00.000Z',
        inputTokens: 1,
        costUsd: 2,
        repoRoot: '/repo/newer',
      }),
      event({
        source: 'codex',
        sessionId: 'e',
        timestamp: '2026-01-02T12:00:00.000Z',
        inputTokens: 1,
        repoRoot: '/repo/unpriced',
      }),
    ]);

    expect(rows.map((row) => row.repoRoot)).toEqual([
      '/repo/newer',
      '/repo/tie-a',
      '/repo/tie-b',
      '/repo/cheap',
      '/repo/unpriced',
    ]);
  });

  it('filters events by local date before repo grouping', () => {
    const rows = aggregateSessionsByRepo(
      [
        event({
          source: 'codex',
          sessionId: 'in-range',
          timestamp: '2026-01-02T10:00:00.000Z',
          inputTokens: 10,
          costUsd: 1,
          repoRoot: '/repo/kept',
        }),
        event({
          source: 'codex',
          sessionId: 'out-of-range',
          timestamp: '2026-01-03T10:00:00.000Z',
          inputTokens: 100,
          costUsd: 5,
          repoRoot: '/repo/dropped',
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
      repoRoot: '/repo/kept',
      sessionCount: 1,
      inputTokens: 10,
      costUsd: 1,
    });
  });
});
