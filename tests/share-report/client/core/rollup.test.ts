import { describe, expect, it } from 'vitest';

import {
  createFilters,
  rollupByDimension,
  rollupByPeriod,
  selectCells,
  selectHourlyCells,
  sumCells,
  type ShareFilters,
} from '../../../../src/share-report/client/core/index.js';
import {
  HOST_TIMEZONES,
  loadFixtureReport,
  readExpectedRollups,
  useHostTimezone,
} from './share-fixture.js';

const ALL: ShareFilters = createFilters({ since: null, until: null });

function withoutIndex<Row extends { index: number }>(rows: Row[]): Omit<Row, 'index'>[] {
  return rows.map((row) => {
    const copy: Partial<Row> = { ...row };
    delete copy.index;
    return copy as Omit<Row, 'index'>;
  });
}

describe.each(HOST_TIMEZONES)('share roll-ups with the host in %s', (hostTimezone) => {
  useHostTimezone(hostTimezone);

  it('runs in the host timezone it names', () => {
    // 2026-01-01T00:00Z is still 2025-12-31 nowhere but 13 hours ahead in Apia.
    const hostHour = new Date(Date.UTC(2026, 0, 1)).getHours();
    expect(hostHour).toBe(hostTimezone === 'UTC' ? 0 : 13);
  });

  it('rolls the fixture up to its expected totals at every granularity and dimension', () => {
    const report = loadFixtureReport();
    const expected = readExpectedRollups();
    const cells = selectCells(report, ALL);

    expect(rollupByPeriod(report, cells, 'day').rows).toEqual(expected.day);
    expect(rollupByPeriod(report, cells, 'week').rows).toEqual(expected.week);
    expect(rollupByPeriod(report, cells, 'month').rows).toEqual(expected.month);
    expect(rollupByPeriod(report, cells, 'hour').rows).toEqual(expected.hour);
    expect(withoutIndex(rollupByDimension(report, cells, 'source'))).toEqual(expected.bySource);
    expect(withoutIndex(rollupByDimension(report, cells, 'model'))).toEqual(expected.byModel);
    expect(withoutIndex(rollupByDimension(report, cells, 'project'))).toEqual(expected.byProject);
    expect(withoutIndex(rollupByDimension(report, cells, 'machine'))).toEqual(expected.byMachine);
    expect(sumCells(report, cells)).toEqual(expected.total);
  });
});

describe('rollupByPeriod', () => {
  it('keeps the repeated hour of a DST fall-back as one key', () => {
    // Europe/Paris goes back from 03:00 to 02:00 on 2026-10-25: both 02:30s share a key.
    const report = loadFixtureReport();
    const hours = rollupByPeriod(report, selectCells(report, ALL), 'hour').rows;

    expect(hours.filter((row) => row.key.startsWith('2026-10-25'))).toMatchObject([
      { key: '2026-10-25 02:00', eventCount: 2 },
    ]);
  });

  it('leaves daily-only cells out of hours and says from when hours start', () => {
    const report = loadFixtureReport();
    const cells = selectCells(report, ALL);

    expect(rollupByPeriod(report, cells, 'hour').hourlyFrom).toBe('2026-10-20');
    expect(rollupByPeriod(report, cells, 'day').hourlyFrom).toBeNull();
    expect(selectHourlyCells(report, cells)).toHaveLength(5);

    const recent = selectCells(report, createFilters({ since: '2026-10-20', until: null }));
    expect(rollupByPeriod(report, recent, 'hour').hourlyFrom).toBeNull();
  });

  it('sums a period from several cells and reports no cost when no cell had one', () => {
    const report = loadFixtureReport();
    const [day] = rollupByPeriod(
      report,
      selectCells(report, createFilters({ since: '2026-10-20', until: '2026-10-20' })),
      'day',
    ).rows;

    expect(day).toMatchObject({ key: '2026-10-20', eventCount: 8, totalTokens: 26900 });
    expect(day.costs.explicit).toEqual({ costUsd: 0.08, incompleteEvents: 6 });
  });

  it('holds only the cost modes the file has', () => {
    const report = loadFixtureReport((data) => {
      delete data.cube.costs.estimated;
      delete data.cube.costs.both;
      data.meta.unavailableCostModes = ['estimated', 'both'];
      data.meta.costMode = 'explicit';
    });

    const total = sumCells(report, selectCells(report, ALL));
    expect(Object.keys(total.costs)).toEqual(['explicit']);
  });

  it('holds no cost with --no-cost', () => {
    const report = loadFixtureReport((data) => {
      data.cube.costs = {};
      data.meta.costMode = null;
    });

    expect(sumCells(report, selectCells(report, ALL)).costs).toEqual({});
  });
});

describe('selectCells', () => {
  it('keeps cells inside the date range and every dimension filter', () => {
    const report = loadFixtureReport();
    const filters = createFilters({ since: '2026-10-20', until: '2026-10-25' });

    expect(selectCells(report, filters)).toEqual([3, 4, 5, 6]);
    expect(selectCells(report, { ...filters, source: [1] })).toEqual([4, 5]);
    expect(selectCells(report, { ...filters, source: [1], machine: [1] })).toEqual([5]);
    expect(selectCells(report, { ...filters, project: [2] })).toEqual([4]);
    expect(selectCells(report, { ...filters, model: [0, 2] })).toEqual([3, 5, 6]);
  });

  it('matches the expected per-source totals when filtering by source', () => {
    const report = loadFixtureReport();
    const [, codexTotals] = readExpectedRollups().bySource as { key: string }[];
    const { key, ...totals } = codexTotals;

    expect(key).toBe('codex');
    expect(sumCells(report, selectCells(report, { ...ALL, source: [1] }))).toEqual(totals);
  });
});
