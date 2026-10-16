import { getDateKeyRange } from '../../../utils/date-key.js';
import type { ShareBlock } from '../../types.js';
import type { ShareReport } from './decode.js';
import { hasBlockIgnoredFilters, isInDateRange, type ShareFilters } from './filters.js';
import { toLocalDateHour } from './local-time.js';
import type { ShareDateSpan } from './period-axis.js';
import { getMetricReader, type ShareMetric } from './stack.js';

/** ISO weekdays, Monday first, as the hour × weekday rows. */
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export type ShareHourWeekdayMatrix = {
  /** `values[weekday - 1][hour]`: Monday first, hours 0–23 local. */
  values: number[][];
  /** The first date with hourly detail when daily-only cells were left out; else null. */
  hourlyFrom: string | null;
  unavailable: boolean;
};

export type ShareBlockMatrix = {
  /** Every local date of the span, one row each. */
  days: string[];
  /** `values[row][hour]`: the metric of the blocks starting in that local hour. */
  values: number[][];
  /** `counts[row][hour]`: how many blocks start in that local hour. */
  counts: number[][];
  /**
   * True when a model, project or machine filter is set: blocks are per source, so they keep
   * every model, project and machine.
   */
  ignoresFilters: boolean;
  unavailable: boolean;
};

function createGrid(rows: number): number[][] {
  return Array.from({ length: rows }, () => new Array<number>(24).fill(0));
}

/** The metric by local hour and weekday over the selected cells that have hourly detail. */
export function buildHourWeekdayMatrix(
  report: ShareReport,
  cells: readonly number[],
  metric: ShareMetric,
): ShareHourWeekdayMatrix {
  const values = createGrid(7);
  const reader = getMetricReader(report, metric);

  if (!reader) {
    return { values, hourlyFrom: null, unavailable: true };
  }

  const periodColumn = report.data.cube.period;
  let clipped = false;

  for (const cell of cells) {
    const period = report.periods[periodColumn[cell]];

    if (period.hour === null) {
      clipped = true;
      continue;
    }

    const row = values[period.weekday - 1];
    row[period.hour] = reader.add(row[period.hour], reader.valueOf(cell));
  }

  return { values, hourlyFrom: clipped ? report.data.meta.hourlyFrom : null, unavailable: false };
}

function getBlockMetric(block: ShareBlock, metric: ShareMetric): number | undefined {
  if (metric.kind === 'tokens') {
    return block.totalTokens;
  }

  const cost = block.costs[metric.mode];
  return cost && (cost.costUsd ?? 0);
}

/**
 * The 5-hour blocks by the local date and hour they start, over the span. Blocks honour the
 * date range and the source filter only.
 */
export function buildBlockMatrix(
  report: ShareReport,
  filters: ShareFilters,
  span: ShareDateSpan,
  metric: ShareMetric,
): ShareBlockMatrix {
  const days = getDateKeyRange(span.first, span.last);
  const values = createGrid(days.length);
  const counts = createGrid(days.length);
  const ignoresFilters = hasBlockIgnoredFilters(filters);
  const reader = getMetricReader(report, metric);

  if (!reader) {
    return { days, values, counts, ignoresFilters, unavailable: true };
  }

  const rowOf = new Map(days.map((day, row) => [day, row]));
  const sources = new Set(filters.source);

  for (const block of report.data.blocks.rows) {
    const local = toLocalDateHour(block.start, report.data.meta.timezone);
    const value = getBlockMetric(block, metric);

    if (
      local === undefined ||
      value === undefined ||
      !isInDateRange(local.dateKey, filters) ||
      (sources.size > 0 && !sources.has(block.source))
    ) {
      continue;
    }

    const row = rowOf.get(local.dateKey);

    if (row !== undefined) {
      values[row][local.hour] = reader.add(values[row][local.hour], value);
      counts[row][local.hour] += 1;
    }
  }

  return { days, values, counts, ignoresFilters, unavailable: false };
}
