import { addUsd } from '../../../utils/usd-math.js';
import type { ShareCostMode, ShareGranularity } from '../../types.js';
import type { ShareReport } from './decode.js';
import { DIMENSION_DICTIONARY, type ShareDimension } from './filters.js';
import { compareText, getPeriodRollupKey } from './rollup.js';

/** What a chart plots: total tokens, or the cost in one mode. */
export type ShareMetric = { kind: 'tokens' } | { kind: 'cost'; mode: ShareCostMode };

export type ShareSeries = {
  /** The dictionary label, or `Other` for the merged remainder. */
  label: string;
  /** The dictionary index; null for `Other`. */
  index: number | null;
  /** One value per axis key. */
  values: number[];
  total: number;
};

export type ShareStack = {
  axis: string[];
  /** Largest total first; `Other`, when present, last. */
  series: ShareSeries[];
  /** True when the metric is a cost mode the file does not hold (pricing failed or --no-cost). */
  unavailable: boolean;
};

export const OTHER_SERIES_LABEL = 'Other';

/** How a metric reads a cube cell and adds values. */
export type ShareMetricReader = {
  /** The cell's value; a cell without a cost reads 0. */
  valueOf: (cell: number) => number;
  /** Token counts add exactly; costs add on the fixed-point USD grid, as the CLI does. */
  add: (left: number, right: number) => number;
};

/** Reads a metric from the cube; undefined when the file holds no cost column for the mode. */
export function getMetricReader(
  report: ShareReport,
  metric: ShareMetric,
): ShareMetricReader | undefined {
  const { cube } = report.data;

  if (metric.kind === 'tokens') {
    return { valueOf: (cell) => cube.totalTokens[cell], add: (left, right) => left + right };
  }

  const columns = cube.costs[metric.mode];
  return columns && { valueOf: (cell) => columns.costUsd[cell] ?? 0, add: addUsd };
}

/**
 * The metric over an axis, one series per label of a dimension: the `maxSeries` largest by
 * total, and the rest merged into one `Other` series after them. Ties order by label.
 */
export function stackByDimension(
  report: ShareReport,
  cells: readonly number[],
  options: {
    axis: readonly string[];
    granularity: ShareGranularity;
    dimension: ShareDimension;
    metric: ShareMetric;
    maxSeries: number;
  },
): ShareStack {
  const axis = [...options.axis];
  const reader = getMetricReader(report, options.metric);

  if (!reader) {
    return { axis, series: [], unavailable: true };
  }

  const position = new Map(axis.map((key, index) => [key, index]));
  const labels = report.data.dictionaries[DIMENSION_DICTIONARY[options.dimension]];
  const column = report.data.cube[options.dimension];
  const periodColumn = report.data.cube.period;
  const byIndex = new Map<number, ShareSeries & { index: number }>();

  for (const cell of cells) {
    const key = getPeriodRollupKey(report.periods[periodColumn[cell]], options.granularity);
    const slot = key === undefined ? undefined : position.get(key);

    if (slot === undefined) {
      continue;
    }

    const index = column[cell];
    let series = byIndex.get(index);

    if (!series) {
      series = {
        label: labels[index],
        index,
        values: new Array<number>(axis.length).fill(0),
        total: 0,
      };
      byIndex.set(index, series);
    }

    const value = reader.valueOf(cell);
    series.values[slot] = reader.add(series.values[slot], value);
    series.total = reader.add(series.total, value);
  }

  const ranked = [...byIndex.values()].sort(
    (left, right) =>
      right.total - left.total || compareText(left.label, right.label) || left.index - right.index,
  );
  const kept: ShareSeries[] = ranked.slice(0, Math.max(0, options.maxSeries));
  const rest = ranked.slice(kept.length);

  if (rest.length > 0) {
    kept.push({
      label: OTHER_SERIES_LABEL,
      index: null,
      values: axis.map((_, slot) =>
        rest.reduce((sum, series) => reader.add(sum, series.values[slot]), 0),
      ),
      total: rest.reduce((sum, series) => reader.add(sum, series.total), 0),
    });
  }

  return { axis, series: kept, unavailable: false };
}
