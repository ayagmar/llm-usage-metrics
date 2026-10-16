import { describe, expect, it } from 'vitest';

import {
  buildBlockMatrix,
  buildHourWeekdayMatrix,
  createFilters,
  getPeriodAxis,
  getViewDateSpan,
  OTHER_SERIES_LABEL,
  selectCells,
  stackByDimension,
  type ShareFilters,
} from '../../../../src/share-report/client/core/index.js';
import { defined, HOST_TIMEZONES, loadFixtureReport, useHostTimezone } from './share-fixture.js';

const ALL: ShareFilters = createFilters({ since: null, until: null });
const LAST_WEEK: ShareFilters = createFilters({ since: '2026-10-20', until: '2026-10-26' });

describe('period axis', () => {
  const report = loadFixtureReport();

  it('spans the filter range, then the window, then the data', () => {
    expect(getViewDateSpan(report, LAST_WEEK)).toEqual({ first: '2026-10-20', last: '2026-10-26' });
    expect(getViewDateSpan(report, ALL)).toEqual({ first: '2025-12-29', last: '2026-10-26' });

    const openWindow = loadFixtureReport((data) => {
      data.meta.window = { since: null, until: null };
    });
    expect(getViewDateSpan(openWindow, ALL)).toEqual({ first: '2025-12-31', last: '2026-10-26' });
    expect(
      getViewDateSpan(report, createFilters({ since: '2026-10-26', until: '2026-10-20' })),
    ).toBeUndefined();
  });

  it('lists every period, including empty ones, and hours only from hourlyFrom', () => {
    const span = defined(getViewDateSpan(report, ALL));

    expect(getPeriodAxis(report, span, 'month')).toHaveLength(11);
    expect(getPeriodAxis(report, span, 'week').slice(0, 2)).toEqual(['2026-W01', '2026-W02']);
    expect(getPeriodAxis(report, { first: '2026-10-25', last: '2026-10-25' }, 'day')).toEqual([
      '2026-10-25',
    ]);

    const hours = getPeriodAxis(report, span, 'hour');
    expect(hours).toHaveLength(7 * 24);
    expect([hours[0], hours.at(-1)]).toEqual(['2026-10-20 00:00', '2026-10-26 23:00']);
  });
});

describe('stackByDimension', () => {
  const report = loadFixtureReport();
  const cells = selectCells(report, LAST_WEEK);
  const axis = getPeriodAxis(report, defined(getViewDateSpan(report, LAST_WEEK)), 'day');

  it('stacks the metric per label over the axis, largest first', () => {
    const stack = stackByDimension(report, cells, {
      axis,
      granularity: 'day',
      dimension: 'source',
      metric: { kind: 'tokens' },
      maxSeries: 5,
    });

    expect(stack.unavailable).toBe(false);
    expect(stack.series.map(({ label, total }) => [label, total])).toEqual([
      ['claude', 26800],
      ['codex', 4300],
    ]);
    expect(stack.series[1].values).toEqual([2600, 0, 0, 0, 0, 0, 1700]);
  });

  it('merges every series after the first N into Other', () => {
    const stack = stackByDimension(report, cells, {
      axis,
      granularity: 'day',
      dimension: 'model',
      metric: { kind: 'cost', mode: 'both' },
      maxSeries: 1,
    });

    expect(stack.series.map(({ label, index, total }) => [label, index, total])).toEqual([
      ['claude-sonnet-4-5', 0, 0.23],
      [OTHER_SERIES_LABEL, null, 0.13],
    ]);
    // Costs add on the USD grid: 0.08 + 0.05 is exactly 0.13.
    expect(stack.series[1].values).toEqual([0.08, 0, 0, 0, 0, 0, 0.05]);
  });

  it('marks a cost mode the file lacks as unavailable', () => {
    const noCost = loadFixtureReport((data) => {
      data.cube.costs = {};
      data.meta.costMode = null;
    });

    expect(
      stackByDimension(noCost, cells, {
        axis,
        granularity: 'day',
        dimension: 'source',
        metric: { kind: 'cost', mode: 'both' },
        maxSeries: 5,
      }),
    ).toEqual({ axis, series: [], unavailable: true });
  });

  it('leaves out cells whose period is not on the axis', () => {
    const stack = stackByDimension(report, selectCells(report, ALL), {
      axis: ['2026-10-20 09:00'],
      granularity: 'hour',
      dimension: 'project',
      metric: { kind: 'tokens' },
      maxSeries: 5,
    });

    expect(stack.series.map(({ label, values }) => [label, values])).toEqual([
      ['alpha', [24300]],
      ['(unattributed)', [1800]],
    ]);
  });
});

describe.each(HOST_TIMEZONES)('heatmaps with the host in %s', (hostTimezone) => {
  useHostTimezone(hostTimezone);
  const report = loadFixtureReport();

  it('sums hourly cells by local weekday and hour, and says when days were left out', () => {
    const matrix = buildHourWeekdayMatrix(report, selectCells(report, ALL), { kind: 'tokens' });

    // 2026-10-20 is a Tuesday, 2026-10-25 a Sunday, 2026-10-26 a Monday.
    expect(matrix.values[1][9]).toBe(26100);
    expect(matrix.values[1][14]).toBe(800);
    expect(matrix.values[6][2]).toBe(2500);
    expect(matrix.values[0][23]).toBe(1700);
    expect(matrix.values.flat().reduce((sum, value) => sum + value, 0)).toBe(31100);
    expect(matrix.hourlyFrom).toBe('2026-10-20');
    expect(
      buildHourWeekdayMatrix(report, selectCells(report, LAST_WEEK), { kind: 'tokens' }).hourlyFrom,
    ).toBeNull();
  });

  it('places each block at the local date and hour it starts, in the report timezone', () => {
    const matrix = buildBlockMatrix(
      report,
      LAST_WEEK,
      defined(getViewDateSpan(report, LAST_WEEK)),
      {
        kind: 'tokens',
      },
    );

    expect(matrix.days).toHaveLength(7);
    // 07:00Z is 09:00 in Paris (CEST); 2026-10-26T22:00Z is 23:00 (CET).
    expect(matrix.values[0][9]).toBe(24300);
    expect(matrix.counts[0][9]).toBe(1);
    expect(matrix.values[6][23]).toBe(1700);
    expect(matrix.counts.flat().reduce((sum, value) => sum + value, 0)).toBe(2);
    expect(matrix.ignoresFilters).toBe(false);
  });
});

describe('buildBlockMatrix', () => {
  const report = loadFixtureReport();
  const span = defined(getViewDateSpan(report, LAST_WEEK));

  it('honours the source filter and ignores model, project and machine filters', () => {
    const codexOnly = buildBlockMatrix(report, { ...LAST_WEEK, source: [1] }, span, {
      kind: 'cost',
      mode: 'explicit',
    });
    expect(codexOnly.values.flat().filter((value) => value > 0)).toEqual([0.05]);

    const byProject = buildBlockMatrix(report, { ...LAST_WEEK, project: [1] }, span, {
      kind: 'tokens',
    });
    expect(byProject.ignoresFilters).toBe(true);
    expect(byProject.counts.flat().reduce((sum, value) => sum + value, 0)).toBe(2);
  });

  it('keeps blocks outside the date range out', () => {
    const matrix = buildBlockMatrix(
      report,
      createFilters({ since: '2026-10-21', until: '2026-10-26' }),
      span,
      { kind: 'tokens' },
    );

    expect(matrix.counts[0][9]).toBe(0);
    expect(matrix.counts[6][23]).toBe(1);
  });

  it('marks a cost mode the file lacks as unavailable', () => {
    const noCost = loadFixtureReport((data) => {
      data.cube.costs = {};
    });

    expect(
      buildBlockMatrix(noCost, LAST_WEEK, span, { kind: 'cost', mode: 'both' }).unavailable,
    ).toBe(true);
    expect(buildHourWeekdayMatrix(noCost, [], { kind: 'cost', mode: 'both' }).unavailable).toBe(
      true,
    );
  });
});
