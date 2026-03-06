import { describe, expect, it } from 'vitest';

import { aggregateTrends } from '../../src/trends/aggregate-trends.js';
import type { UsageReportRow } from '../../src/domain/usage-report-row.js';

function createUsageRow(overrides: Partial<UsageReportRow>): UsageReportRow {
  return {
    rowType: 'period_source',
    periodKey: '2026-03-04',
    source: 'pi',
    models: [],
    modelBreakdown: [],
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 15,
    costUsd: 1,
    ...overrides,
  } as UsageReportRow;
}

describe('aggregateTrends', () => {
  it('prefers period_combined rows and fills gaps in the combined series', () => {
    const result = aggregateTrends(
      [
        createUsageRow({ periodKey: '2026-03-04', source: 'pi', totalTokens: 10 }),
        createUsageRow({
          periodKey: '2026-03-04',
          rowType: 'period_combined',
          source: 'combined',
          totalTokens: 25,
        }),
        createUsageRow({ periodKey: '2026-03-06', source: 'pi', totalTokens: 20 }),
      ],
      {
        dateRange: { from: '2026-03-04', to: '2026-03-06' },
        metric: 'tokens',
        bySource: false,
        sourceOrder: ['pi'],
      },
    );

    expect(result.totalSeries.buckets).toEqual([
      { date: '2026-03-04', value: 25, observed: true, incomplete: undefined },
      { date: '2026-03-05', value: 0, observed: false },
      { date: '2026-03-06', value: 20, observed: true, incomplete: undefined },
    ]);
    expect(result.totalSeries.summary.observedDayCount).toBe(2);
  });

  it('emits source series in configured source order and omits empty sources', () => {
    const result = aggregateTrends(
      [
        createUsageRow({ periodKey: '2026-03-04', source: 'codex', totalTokens: 20 }),
        createUsageRow({ periodKey: '2026-03-05', source: 'pi', totalTokens: 10 }),
      ],
      {
        dateRange: { from: '2026-03-04', to: '2026-03-05' },
        metric: 'tokens',
        bySource: true,
        sourceOrder: ['pi', 'codex', 'gemini'],
      },
    );

    expect(result.sourceSeries?.map((series) => series.source)).toEqual(['pi', 'codex']);
    expect(result.sourceSeries?.[0]?.buckets.map((bucket) => bucket.value)).toEqual([0, 10]);
    expect(result.sourceSeries?.[1]?.buckets.map((bucket) => bucket.value)).toEqual([20, 0]);
  });

  it('clears the peak summary when the selected range has no observed days', () => {
    const result = aggregateTrends([], {
      dateRange: { from: '2026-03-04', to: '2026-03-06' },
      metric: 'tokens',
      bySource: false,
      sourceOrder: ['pi'],
    });

    expect(result.totalSeries.summary).toMatchObject({
      total: 0,
      average: 0,
      peak: { date: '', value: 0 },
      observedDayCount: 0,
    });
  });

  it('chooses the peak date from observed buckets when gap buckets tie at zero', () => {
    const result = aggregateTrends(
      [createUsageRow({ periodKey: '2026-03-06', totalTokens: 0, costUsd: 0 })],
      {
        dateRange: { from: '2026-03-04', to: '2026-03-06' },
        metric: 'tokens',
        bySource: false,
        sourceOrder: ['pi'],
      },
    );

    expect(result.totalSeries.summary.observedDayCount).toBe(1);
    expect(result.totalSeries.summary.peak).toEqual({
      date: '2026-03-06',
      value: 0,
    });
  });
});
