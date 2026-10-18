import { addUsd } from '../../../utils/usd-math.js';
import type { ShareCosts, ShareGranularity, ShareTokenBuckets } from '../../types.js';
import { COST_MODES, type SharePeriod, type ShareReport } from './decode.js';
import { DIMENSION_DICTIONARY, type ShareDimension } from './filters.js';
import { compareByCodePoint } from '../../../../packages/core/src/utils/compare-by-code-point.js';

/** Sums over a group of cube cells, with one cost per mode the file holds. */
export type ShareTotals = ShareTokenBuckets & {
  eventCount: number;
  activeMs: number;
  costs: ShareCosts;
};

export type SharePeriodRow = ShareTotals & { key: string };

export type ShareDimensionRow = ShareTotals & {
  /** The dictionary label. */
  key: string;
  /** The dictionary index, for filters and drill-down. */
  index: number;
};

export type SharePeriodRollup = {
  rows: SharePeriodRow[];
  /**
   * With `hour`, the first date with hourly detail when daily-only cells were left out of the
   * selection; null when nothing was left out.
   */
  hourlyFrom: string | null;
};

const MEASURES = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'eventCount',
  'activeMs',
] as const;

function createTotals(report: ShareReport): ShareTotals {
  const costs: ShareCosts = {};

  for (const mode of COST_MODES) {
    if (report.data.cube.costs[mode]) {
      costs[mode] = { costUsd: null, incompleteEvents: 0 };
    }
  }

  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    eventCount: 0,
    activeMs: 0,
    costs,
  };
}

/** Adds one cube cell; a cost stays null until a cell in the group has one. */
function addCell(totals: ShareTotals, report: ShareReport, cell: number): void {
  const { cube } = report.data;

  for (const measure of MEASURES) {
    totals[measure] += cube[measure][cell];
  }

  for (const mode of COST_MODES) {
    const columns = cube.costs[mode];
    const cost = totals.costs[mode];

    if (!columns || !cost) {
      continue;
    }

    const costUsd = columns.costUsd[cell];
    cost.incompleteEvents += columns.incompleteEvents[cell];

    if (costUsd !== null) {
      cost.costUsd = addUsd(cost.costUsd ?? 0, costUsd);
    }
  }
}

export function sumCells(report: ShareReport, cells: readonly number[]): ShareTotals {
  const totals = createTotals(report);

  for (const cell of cells) {
    addCell(totals, report, cell);
  }

  return totals;
}

/** The roll-up key of a period at a granularity; undefined for a daily cell at `hour`. */
export function getPeriodRollupKey(
  period: SharePeriod,
  granularity: ShareGranularity,
): string | undefined {
  switch (granularity) {
    case 'hour':
      return period.hour === null ? undefined : period.key;
    case 'day':
      return period.dateKey;
    case 'week':
      return period.weekKey;
    case 'month':
      return period.monthKey;
  }
}

function sortedRows<Row extends { key: string }>(groups: Map<string, Row>): Row[] {
  return [...groups.values()].sort((left, right) => compareByCodePoint(left.key, right.key));
}

/**
 * Totals by local period, in key order, for periods with data. Hour keys come from the cube as
 * they are (the repeated hour at a DST fall-back is one key); cells before `meta.hourlyFrom`
 * have no hour and are left out at `hour`.
 */
export function rollupByPeriod(
  report: ShareReport,
  cells: readonly number[],
  granularity: ShareGranularity,
): SharePeriodRollup {
  const groups = new Map<string, SharePeriodRow>();
  const periodColumn = report.data.cube.period;
  let clipped = false;

  for (const cell of cells) {
    const key = getPeriodRollupKey(report.periods[periodColumn[cell]], granularity);

    if (key === undefined) {
      clipped = true;
      continue;
    }

    let row = groups.get(key);

    if (!row) {
      row = { key, ...createTotals(report) };
      groups.set(key, row);
    }

    addCell(row, report, cell);
  }

  return {
    rows: sortedRows(groups),
    hourlyFrom: clipped ? report.data.meta.hourlyFrom : null,
  };
}

/** Totals by one dimension's index, in label order, for labels with data. */
export function rollupByDimension(
  report: ShareReport,
  cells: readonly number[],
  dimension: ShareDimension,
): ShareDimensionRow[] {
  const labels = report.data.dictionaries[DIMENSION_DICTIONARY[dimension]];
  const column = report.data.cube[dimension];
  const groups = new Map<number, ShareDimensionRow>();

  for (const cell of cells) {
    const index = column[cell];
    let row = groups.get(index);

    if (!row) {
      row = { key: labels[index], index, ...createTotals(report) };
      groups.set(index, row);
    }

    addCell(row, report, cell);
  }

  return [...groups.values()].sort(
    (left, right) => compareByCodePoint(left.key, right.key) || left.index - right.index,
  );
}

/** The selected cells that have hourly detail (from `meta.hourlyFrom`). */
export function selectHourlyCells(report: ShareReport, cells: readonly number[]): number[] {
  const periodColumn = report.data.cube.period;
  return cells.filter((cell) => report.periods[periodColumn[cell]].hour !== null);
}
