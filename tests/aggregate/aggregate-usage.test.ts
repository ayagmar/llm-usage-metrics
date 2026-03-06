import { describe, expect, it } from 'vitest';

import { aggregateUsage } from '../../src/aggregate/aggregate-usage.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';

describe('aggregateUsage', () => {
  it('produces source rows, period combined rows, and grand totals', () => {
    const events = [
      createUsageEvent({
        source: 'pi',
        sessionId: 's1',
        timestamp: '2026-02-10T10:00:00Z',
        model: 'gpt-4.1',
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 1,
        totalTokens: 16,
        costUsd: 1,
        costMode: 'explicit',
      }),
      createUsageEvent({
        source: 'codex',
        sessionId: 's2',
        timestamp: '2026-02-10T13:00:00Z',
        model: 'gpt-5-codex',
        inputTokens: 20,
        outputTokens: 10,
        reasoningTokens: 2,
        cacheReadTokens: 5,
        totalTokens: 37,
        costUsd: 0.5,
        costMode: 'estimated',
      }),
      createUsageEvent({
        source: 'pi',
        sessionId: 's3',
        timestamp: '2026-02-11T09:00:00Z',
        model: 'gpt-4.1',
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
      }),
    ];

    const rows = aggregateUsage(events, {
      granularity: 'daily',
      timezone: 'UTC',
      sourceOrder: ['pi', 'codex'],
    });

    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      rowType: 'period_source',
      periodKey: '2026-02-10',
      source: 'pi',
      totalTokens: 16,
      costUsd: 1,
      models: ['gpt-4.1'],
      modelBreakdown: [
        {
          model: 'gpt-4.1',
          totalTokens: 16,
          costUsd: 1,
        },
      ],
    });
    expect(rows[1]).toMatchObject({
      rowType: 'period_source',
      periodKey: '2026-02-10',
      source: 'codex',
      totalTokens: 37,
      costUsd: 0.5,
      models: ['gpt-5-codex'],
    });
    expect(rows[2]).toMatchObject({
      rowType: 'period_combined',
      periodKey: '2026-02-10',
      source: 'combined',
      totalTokens: 53,
      costUsd: 1.5,
      models: ['gpt-4.1', 'gpt-5-codex'],
      modelBreakdown: [
        {
          model: 'gpt-4.1',
          totalTokens: 16,
          costUsd: 1,
        },
        {
          model: 'gpt-5-codex',
          totalTokens: 37,
          costUsd: 0.5,
        },
      ],
    });

    expect(rows[3]).toMatchObject({
      rowType: 'period_source',
      periodKey: '2026-02-11',
      source: 'pi',
      totalTokens: 5,
      costIncomplete: true,
    });
    expect(rows[3]?.costUsd).toBeUndefined();
    expect(rows[4]).toMatchObject({
      rowType: 'grand_total',
      periodKey: 'ALL',
      totalTokens: 58,
      costUsd: 1.5,
      costIncomplete: true,
      modelBreakdown: [
        {
          model: 'gpt-4.1',
          totalTokens: 21,
          costUsd: 1,
          costIncomplete: true,
        },
        {
          model: 'gpt-5-codex',
          totalTokens: 37,
          costUsd: 0.5,
        },
      ],
    });
  });

  it('splits weeks at Monday boundary', () => {
    const events = [
      createUsageEvent({
        source: 'pi',
        sessionId: 'week-1',
        timestamp: '2026-01-04T12:00:00Z',
        model: 'gpt-4.1',
        inputTokens: 1,
        outputTokens: 1,
      }),
      createUsageEvent({
        source: 'pi',
        sessionId: 'week-2',
        timestamp: '2026-01-05T12:00:00Z',
        model: 'gpt-4.1',
        inputTokens: 2,
        outputTokens: 2,
      }),
    ];

    const rows = aggregateUsage(events, { granularity: 'weekly', timezone: 'UTC' });

    expect(rows[0]).toMatchObject({
      periodKey: '2026-W01',
      rowType: 'period_source',
      totalTokens: 2,
    });
    expect(rows[1]).toMatchObject({
      periodKey: '2026-W02',
      rowType: 'period_source',
      totalTokens: 4,
    });
    expect(rows[2]).toMatchObject({ rowType: 'grand_total', totalTokens: 6 });
  });

  it('normalizes model keys case-insensitively before aggregating model totals', () => {
    const events = [
      createUsageEvent({
        source: 'pi',
        sessionId: 's1',
        timestamp: '2026-02-10T10:00:00Z',
        model: 'gpt-4.1',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 1,
        costMode: 'explicit',
      }),
      createUsageEvent({
        source: 'pi',
        sessionId: 's2',
        timestamp: '2026-02-10T11:00:00Z',
        model: '  GPT-4.1  ',
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        costUsd: 2,
        costMode: 'explicit',
      }),
    ];

    const rows = aggregateUsage(events, { granularity: 'daily', timezone: 'UTC' });
    const periodRow = rows.find((row) => row.rowType === 'period_source');

    expect(periodRow).toMatchObject({
      models: ['gpt-4.1'],
      modelBreakdown: [
        {
          model: 'gpt-4.1',
          totalTokens: 45,
          costUsd: 3,
        },
      ],
    });
  });

  it('can skip model breakdown work for reports that only need totals', () => {
    const events = [
      createUsageEvent({
        source: 'pi',
        sessionId: 's1',
        timestamp: '2026-02-10T10:00:00Z',
        model: 'gpt-4.1',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 1,
        costMode: 'explicit',
      }),
      createUsageEvent({
        source: 'codex',
        sessionId: 's2',
        timestamp: '2026-02-10T11:00:00Z',
        model: 'gpt-5-codex',
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        costUsd: 2,
        costMode: 'explicit',
      }),
    ];

    const rows = aggregateUsage(events, {
      granularity: 'daily',
      timezone: 'UTC',
      includeModelBreakdown: false,
    });

    expect(
      rows.find((row) => row.rowType === 'period_source' && row.source === 'pi'),
    ).toMatchObject({
      rowType: 'period_source',
      totalTokens: 15,
      models: [],
      modelBreakdown: [],
    });
    expect(rows.find((row) => row.rowType === 'period_combined')).toMatchObject({
      rowType: 'period_combined',
      totalTokens: 45,
      models: [],
      modelBreakdown: [],
    });
    expect(rows.at(-1)).toMatchObject({
      rowType: 'grand_total',
      totalTokens: 45,
      models: [],
      modelBreakdown: [],
    });
  });

  it('keeps usd totals numerically stable for many small costs', () => {
    const events = Array.from({ length: 10_000 }, (_, index) => {
      const second = index % 60;
      const minute = Math.floor(index / 60) % 60;
      const hour = Math.floor(index / 3600) % 24;
      const timestamp = `2026-03-01T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;

      return createUsageEvent({
        source: 'pi',
        sessionId: `stable-cost-${index}`,
        timestamp,
        model: 'gpt-4.1',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUsd: 0.001,
        costMode: 'explicit',
      });
    });

    const rows = aggregateUsage(events, { granularity: 'daily', timezone: 'UTC' });
    const grandTotalRow = rows.at(-1);

    expect(grandTotalRow).toMatchObject({
      rowType: 'grand_total',
      periodKey: 'ALL',
      totalTokens: 20_000,
      costUsd: 10,
    });
  });

  it('preserves known cost totals while flagging incomplete pricing', () => {
    const rows = aggregateUsage(
      [
        createUsageEvent({
          source: 'pi',
          sessionId: 'known',
          timestamp: '2026-02-10T10:00:00Z',
          model: 'gpt-4.1',
          inputTokens: 10,
          outputTokens: 10,
          totalTokens: 20,
          costUsd: 1.25,
          costMode: 'explicit',
        }),
        createUsageEvent({
          source: 'pi',
          sessionId: 'unknown',
          timestamp: '2026-02-10T11:00:00Z',
          model: 'gpt-4.1',
          inputTokens: 5,
          outputTokens: 5,
          totalTokens: 10,
          costMode: 'estimated',
          costUsd: undefined,
        }),
      ],
      { granularity: 'daily', timezone: 'UTC' },
    );

    expect(rows[0]).toMatchObject({
      rowType: 'period_source',
      source: 'pi',
      totalTokens: 30,
      costUsd: 1.25,
      costIncomplete: true,
      modelBreakdown: [
        {
          model: 'gpt-4.1',
          totalTokens: 30,
          costUsd: 1.25,
          costIncomplete: true,
        },
      ],
    });
    expect(rows[1]).toMatchObject({
      rowType: 'grand_total',
      totalTokens: 30,
      costUsd: 1.25,
      costIncomplete: true,
    });
  });

  it('sorts same-weight sources deterministically by code-point order', () => {
    const rows = aggregateUsage(
      [
        createUsageEvent({
          source: 'ä-source',
          sessionId: 's1',
          timestamp: '2026-02-10T10:00:00Z',
          model: 'model-a',
          inputTokens: 1,
          outputTokens: 1,
        }),
        createUsageEvent({
          source: 'z-source',
          sessionId: 's2',
          timestamp: '2026-02-10T10:10:00Z',
          model: 'model-z',
          inputTokens: 1,
          outputTokens: 1,
        }),
      ],
      { granularity: 'daily', timezone: 'UTC' },
    );

    const periodSourceRows = rows.filter((row) => row.rowType === 'period_source');
    expect(periodSourceRows.map((row) => row.source)).toEqual(['z-source', 'ä-source']);
  });

  it('keeps grand-total cost at zero when there are no events', () => {
    const rows = aggregateUsage([], { granularity: 'daily', timezone: 'UTC' });

    expect(rows).toEqual([
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: [],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      },
    ]);
  });
});
