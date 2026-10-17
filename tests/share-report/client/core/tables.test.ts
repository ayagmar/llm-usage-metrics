import { describe, expect, it } from 'vitest';

import {
  buildNameMask,
  createFilters,
  formatUsdOrNone,
  getCacheHitRate,
  getCost,
  getCostAmount,
  getCostPerActiveHour,
  getDefaultCostMode,
  getOmittedSessionCount,
  NO_VALUE,
  paginate,
  rollupByDimension,
  selectCells,
  selectSessions,
  sortRows,
  sumCells,
  type ShareDimensionRow,
  type TableSortKey,
} from '../../../../src/share-report/client/core/index.js';
import { HOST_TIMEZONES, loadFixtureReport, useHostTimezone } from './share-fixture.js';

const ALL = createFilters({ since: null, until: null });

describe('cost modes and derived metrics', () => {
  const report = loadFixtureReport();
  const total = sumCells(report, selectCells(report, ALL));

  it('reads a mode, an unavailable mode and no cost at all apart', () => {
    expect(getCost(report, total.costs, 'explicit')).toEqual({
      kind: 'value',
      costUsd: 0.25,
      incompleteEvents: 11,
    });
    expect(getCost(report, total.costs, null)).toEqual({ kind: 'none' });

    const explicitOnly = loadFixtureReport((data) => {
      delete data.cube.costs.estimated;
      delete data.cube.costs.both;
      data.meta.unavailableCostModes = ['estimated', 'both'];
      data.meta.costMode = 'both';
    });
    const explicitTotal = sumCells(explicitOnly, selectCells(explicitOnly, ALL));

    expect(getDefaultCostMode(explicitOnly)).toBe('explicit');
    expect(getCost(explicitOnly, explicitTotal.costs, 'estimated')).toEqual({
      kind: 'unavailable',
    });
    expect(getCostAmount({ kind: 'unavailable' })).toBeNull();
    expect(getCostAmount({ kind: 'value', costUsd: null, incompleteEvents: 1 })).toBe(0);
  });

  it('opens on no cost mode with --no-cost', () => {
    const noCost = loadFixtureReport((data) => {
      data.cube.costs = {};
      data.meta.costMode = null;
    });

    expect(getDefaultCostMode(noCost)).toBeNull();
  });

  it('computes the cache hit rate over every prompt token', () => {
    expect(getCacheHitRate(total)).toBeCloseTo(28300 / (10100 + 28300 + 600), 12);
    expect(getCacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });

  it('shows cost per active hour, and a dash without active time', () => {
    expect(getCostPerActiveHour(0.54, 2040000)).toBeCloseTo(0.952941, 6);
    expect(formatUsdOrNone(getCostPerActiveHour(0.54, 2040000))).toBe('$0.95');
    expect(formatUsdOrNone(getCostPerActiveHour(0.01, 0))).toBe(NO_VALUE);
    expect(formatUsdOrNone(getCostPerActiveHour(null, 60000))).toBe('—');
  });
});

describe('table sort and pagination', () => {
  const report = loadFixtureReport();
  const projects = rollupByDimension(report, selectCells(report, ALL), 'project');
  const valueOf = (row: ShareDimensionRow, key: TableSortKey) =>
    key === 'label'
      ? row.key
      : key === 'cost'
        ? (row.costs.explicit?.costUsd ?? null)
        : key === 'totalTokens'
          ? row.totalTokens
          : null;

  it('sorts by a column either way, with empty cells last and ties by label', () => {
    const byCost = (direction: 'asc' | 'desc') =>
      sortRows(projects, { key: 'cost', direction }, valueOf).map((row) => row.key);

    expect(byCost('desc')).toEqual(['beta', '(unattributed)', 'alpha']);
    expect(byCost('asc')).toEqual(['alpha', '(unattributed)', 'beta']);
    expect(
      sortRows(projects, { key: 'label', direction: 'desc' }, valueOf).map((row) => row.key),
    ).toEqual(['beta', 'alpha', '(unattributed)']);

    const noValue = sortRows(projects, { key: 'activeMs', direction: 'desc' }, valueOf);
    expect(noValue.map((row) => row.key)).toEqual(['(unattributed)', 'alpha', 'beta']);
  });

  it('puts empty cells last in both directions', () => {
    const rows = [
      { label: 'a', value: null },
      { label: 'b', value: 2 },
      { label: 'c', value: 1 },
    ];
    const sorted = (direction: 'asc' | 'desc') =>
      sortRows(rows, { key: 'cost', direction }, (row, key) =>
        key === 'label' ? row.label : row.value,
      ).map((row) => row.label);

    expect(sorted('asc')).toEqual(['c', 'b', 'a']);
    expect(sorted('desc')).toEqual(['b', 'c', 'a']);
  });

  it('clamps pages into range', () => {
    const rows = Array.from({ length: 45 }, (_, index) => index);

    expect(paginate(rows, 0, 20)).toMatchObject({ page: 0, pageCount: 3, rowCount: 45 });
    expect(paginate(rows, 2, 20).rows).toEqual([40, 41, 42, 43, 44]);
    expect(paginate(rows, 9, 20).page).toBe(2);
    expect(paginate(rows, -1, 20).page).toBe(0);
    expect(paginate(rows, Number.NaN, 20).page).toBe(0);
    expect(paginate([], 0, 20)).toEqual({ rows: [], page: 0, pageCount: 1, rowCount: 0 });
  });
});

describe.each(HOST_TIMEZONES)('sessions with the host in %s', (hostTimezone) => {
  useHostTimezone(hostTimezone);
  const report = loadFixtureReport();
  const labels = (filters = ALL, project: number | null = null) =>
    selectSessions(report, filters, project).map((session) => session.label);

  it('drills into one project and keeps the sessions inside the filters', () => {
    expect(labels()).toHaveLength(3);
    expect(labels(ALL, 0)).toEqual(['codex · 2026-10-26 23:05', 'claude · 2026-10-20 09:10']);
    expect(labels({ ...ALL, source: [0] })).toEqual([
      'claude · 2026-10-25 02:30',
      'claude · 2026-10-20 09:10',
    ]);
    expect(labels({ ...ALL, model: [1] })).toEqual(['codex · 2026-10-26 23:05']);
    expect(labels({ ...ALL, machine: [1] })).toEqual([]);
  });

  it('keeps sessions active on the local dates of the range', () => {
    // 2026-10-26T22:05Z is 23:05 on the 26th in Paris, already the 27th in Apia.
    expect(labels(createFilters({ since: '2026-10-26', until: '2026-10-26' }))).toEqual([
      'codex · 2026-10-26 23:05',
    ]);
    expect(labels(createFilters({ since: '2026-10-21', until: '2026-10-24' }))).toEqual([]);
  });

  it('counts the sessions the file left out', () => {
    expect(getOmittedSessionCount(report, 0)).toBe(4);
    expect(getOmittedSessionCount(report, 1)).toBe(0);
    expect(getOmittedSessionCount(report, null)).toBe(4);
  });
});

describe('buildNameMask', () => {
  it('numbers projects and machines by tokens and keeps local and unattributed', () => {
    const mask = buildNameMask(loadFixtureReport());

    expect(mask.projects).toEqual(['project-1', 'project-2', '(unattributed)']);
    expect(mask.machines).toEqual(['local', 'machine-1']);
    expect(mask.project.get('beta')).toBe('project-2');
    expect(mask.machine.get('laptop')).toBe('machine-1');
  });

  it('orders ties by label and leaves a redacted file as it is', () => {
    const tied = loadFixtureReport((data) => {
      data.cube.totalTokens = data.cube.totalTokens.map(() => 1);
      data.cube.project = [0, 1, 0, 1, 2, 0, 1, 2];
    });
    expect(buildNameMask(tied).projects).toEqual(['project-1', 'project-2', '(unattributed)']);

    const redacted = loadFixtureReport((data) => {
      data.meta.redacted = true;
      data.dictionaries.projects = ['project-2', 'project-1', '(unattributed)'];
    });
    expect(buildNameMask(redacted).projects).toEqual(['project-2', 'project-1', '(unattributed)']);
  });
});
