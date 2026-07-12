import { describe, expect, it } from 'vitest';

import { aggregateTrends } from '../../src/trends/aggregate-trends.js';
import type { TrendValueRow } from '../../src/trends/trends-series.js';

function createValueRow(overrides: Partial<TrendValueRow>): TrendValueRow {
  return {
    periodKey: '2026-03-04',
    source: 'pi',
    value: 15,
    ...overrides,
  };
}

describe('aggregateTrends', () => {
  it('prefers combined rows and fills gaps in the combined series', () => {
    const result = aggregateTrends(
      [
        createValueRow({ periodKey: '2026-03-04', source: 'pi', value: 10 }),
        createValueRow({ periodKey: '2026-03-04', source: 'combined', value: 25 }),
        createValueRow({ periodKey: '2026-03-06', source: 'pi', value: 20 }),
      ],
      {
        dateRange: { from: '2026-03-04', to: '2026-03-06' },
        bySource: false,
        sourceOrder: ['pi'],
      },
    );

    expect(result.totalSeries.buckets).toEqual([
      { date: '2026-03-04', value: 25, observed: true, incomplete: undefined },
      { date: '2026-03-05', value: 0, observed: false },
      { date: '2026-03-06', value: 20, observed: true, incomplete: undefined },
    ]);
    expect(result.sourceSeries).toBeUndefined();
    expect(result.totalSeries.summary.observedDayCount).toBe(2);
  });

  it('emits source series in configured source order and omits empty sources', () => {
    const result = aggregateTrends(
      [
        createValueRow({ periodKey: '2026-03-04', source: 'codex', value: 20 }),
        createValueRow({ periodKey: '2026-03-05', source: 'pi', value: 10 }),
      ],
      {
        dateRange: { from: '2026-03-04', to: '2026-03-05' },
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

  it('returns an empty bucket list when the requested date range is reversed', () => {
    const result = aggregateTrends([], {
      dateRange: { from: '2026-03-06', to: '2026-03-04' },
      bySource: false,
      sourceOrder: ['pi'],
    });

    expect(result.totalSeries.buckets).toEqual([]);
    expect(result.totalSeries.summary).toMatchObject({
      total: 0,
      average: 0,
      peak: { date: '', value: 0 },
      observedDayCount: 0,
    });
  });

  it('chooses the peak date from observed buckets when gap buckets tie at zero', () => {
    const result = aggregateTrends([createValueRow({ periodKey: '2026-03-06', value: 0 })], {
      dateRange: { from: '2026-03-04', to: '2026-03-06' },
      bySource: false,
      sourceOrder: ['pi'],
    });

    expect(result.totalSeries.summary.observedDayCount).toBe(1);
    expect(result.totalSeries.summary.peak).toEqual({
      date: '2026-03-06',
      value: 0,
    });
  });

  it('keeps known sources ahead of unknown ones and sorts unknown sources deterministically', () => {
    const result = aggregateTrends(
      [
        createValueRow({ periodKey: '2026-03-04', source: 'beta', value: 5 }),
        createValueRow({ periodKey: '2026-03-04', source: 'pi', value: 10 }),
        createValueRow({ periodKey: '2026-03-04', source: 'alpha', value: 15 }),
      ],
      {
        dateRange: { from: '2026-03-04', to: '2026-03-04' },
        bySource: true,
        sourceOrder: ['pi'],
      },
    );

    expect(result.sourceSeries?.map((series) => series.source)).toEqual(['pi', 'alpha', 'beta']);
  });

  it('sums source rows into the combined series when no combined row exists', () => {
    const result = aggregateTrends(
      [
        createValueRow({ periodKey: '2026-03-04', source: 'pi', value: 10 }),
        createValueRow({ periodKey: '2026-03-04', source: 'codex', value: 15 }),
      ],
      {
        dateRange: { from: '2026-03-04', to: '2026-03-04' },
        bySource: false,
        sourceOrder: ['pi', 'codex'],
      },
    );

    expect(result.totalSeries.buckets).toEqual([
      { date: '2026-03-04', value: 25, observed: true, incomplete: undefined },
    ]);
  });

  it('merges duplicate rows for the same source and day in source series', () => {
    const result = aggregateTrends(
      [
        createValueRow({ periodKey: '2026-03-04', source: 'pi', value: 10 }),
        createValueRow({ periodKey: '2026-03-04', source: 'pi', value: 15 }),
      ],
      {
        dateRange: { from: '2026-03-04', to: '2026-03-04' },
        bySource: true,
        sourceOrder: ['pi'],
      },
    );

    expect(result.sourceSeries?.[0]?.buckets).toEqual([
      { date: '2026-03-04', value: 25, observed: true, incomplete: undefined },
    ]);
  });

  it('ignores combined rows when building source series', () => {
    const result = aggregateTrends(
      [
        createValueRow({ periodKey: '2026-03-04', source: 'combined', value: 25 }),
        createValueRow({ periodKey: 'ALL', source: 'combined', value: 99 }),
      ],
      {
        dateRange: { from: '2026-03-04', to: '2026-03-04' },
        bySource: true,
        sourceOrder: ['pi'],
      },
    );

    expect(result.sourceSeries).toEqual([]);
  });

  it('rounds merged totals for combined source-only rows', () => {
    const result = aggregateTrends(
      [
        createValueRow({ periodKey: '2026-03-04', source: 'pi', value: 0.1 }),
        createValueRow({ periodKey: '2026-03-04', source: 'codex', value: 0.2 }),
      ],
      {
        dateRange: { from: '2026-03-04', to: '2026-03-04' },
        bySource: false,
        sourceOrder: ['pi', 'codex'],
      },
    );

    expect(result.totalSeries.buckets).toEqual([
      { date: '2026-03-04', value: 0.3, observed: true, incomplete: undefined },
    ]);
    expect(result.totalSeries.summary).toMatchObject({
      total: 0.3,
      average: 0.3,
      peak: { date: '2026-03-04', value: 0.3 },
    });
  });

  it('marks series as incomplete when observed rows are missing resolved pricing', () => {
    const result = aggregateTrends(
      [
        createValueRow({ periodKey: '2026-03-04', value: 0, incomplete: true }),
        createValueRow({ periodKey: 'ALL', source: 'combined', value: 99 }),
      ],
      {
        dateRange: { from: '2026-03-04', to: '2026-03-04' },
        bySource: false,
        sourceOrder: ['pi'],
      },
    );

    expect(result.totalSeries.buckets).toEqual([
      { date: '2026-03-04', value: 0, observed: true, incomplete: true },
    ]);
    expect(result.totalSeries.summary).toMatchObject({
      total: 0,
      average: 0,
      peak: { date: '2026-03-04', value: 0 },
      incomplete: true,
      observedDayCount: 1,
    });
  });
});
