import { getDateKeyRange } from '../../../utils/date-key.js';
import { addUsd } from '../../../utils/usd-math.js';
import type { ShareBlock, ShareCost } from '../../types.js';
import type { ShareReport } from './decode.js';
import { hasBlockIgnoredFilters, type ShareFilters } from './filters.js';
import { toLocalDateHour, type LocalDateHour } from './local-time.js';
import type { ShareDateSpan } from './period-axis.js';
import { getMetricReader, type ShareMetric, type ShareMetricReader } from './stack.js';

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
  /**
   * Every local date of the span, one row each, led by the day before it when a block that
   * started then runs into the span.
   */
  days: string[];
  /** `values[row][hour]`: the metric of the blocks starting in that local hour. */
  values: number[][];
  /** `counts[row][hour]`: how many blocks start in that local hour. */
  counts: number[][];
  /**
   * With a cost metric, `costs[row][hour]`: the cost of those blocks, null when none had a
   * price, and how many of their events had none. Empty with tokens.
   */
  costs: ShareCost[][];
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

/** A block's metric, and with a cost metric the cost it comes from. */
type BlockValue = { value: number; cost: ShareCost | undefined };

function getBlockValue(
  block: Pick<ShareBlock, 'totalTokens' | 'costs'>,
  metric: ShareMetric,
): BlockValue | undefined {
  if (metric.kind === 'tokens') {
    return { value: block.totalTokens, cost: undefined };
  }

  const cost = block.costs[metric.mode];
  return cost && { value: cost.costUsd ?? 0, cost };
}

/** A sum of costs: null until one has a price, with every event that had none. */
function addCost(left: ShareCost, right: ShareCost): ShareCost {
  return {
    costUsd:
      left.costUsd === null || right.costUsd === null
        ? (left.costUsd ?? right.costUsd)
        : addUsd(left.costUsd, right.costUsd),
    incompleteEvents: left.incompleteEvents + right.incompleteEvents,
  };
}

function addBlockValues(
  left: BlockValue,
  right: BlockValue,
  reader: ShareMetricReader,
): BlockValue {
  return {
    value: reader.add(left.value, right.value),
    cost: left.cost && right.cost && addCost(left.cost, right.cost),
  };
}

/**
 * The metric of a block's usage up to the end of `last`, as `blocks --until` counts it:
 * events after that date are left out. Undefined when the block has none up to then, or
 * lacks the cost mode.
 */
function getBlockValueUntil(
  block: ShareBlock,
  metric: ShareMetric,
  last: string,
  reader: ShareMetricReader,
  timezone: string,
): BlockValue | undefined {
  if (block.days === undefined) {
    const firstEvent = toLocalDateHour(block.firstEventAt, timezone);
    return firstEvent === undefined || firstEvent.dateKey > last
      ? undefined
      : getBlockValue(block, metric);
  }

  let total: BlockValue | undefined;

  for (const day of block.days) {
    const value = getBlockValue(day, metric);

    if (day.date <= last && value !== undefined) {
      total = total === undefined ? value : addBlockValues(total, value, reader);
    }
  }

  return total;
}

/**
 * The 5-hour blocks by the local date and hour they start. Blocks honour the span (the date
 * range) and the source filter only, and like `blocks` a block counts when it runs into the
 * range: one that started the evening before the span gets a leading row for that day. A
 * block running past the span's end counts only its usage up to that end.
 */
export function buildBlockMatrix(
  report: ShareReport,
  filters: ShareFilters,
  span: ShareDateSpan,
  metric: ShareMetric,
): ShareBlockMatrix {
  const ignoresFilters = hasBlockIgnoredFilters(filters);
  const reader = getMetricReader(report, metric);

  if (!reader) {
    const days = getDateKeyRange(span.first, span.last);
    return {
      days,
      values: createGrid(days.length),
      counts: createGrid(days.length),
      costs: [],
      ignoresFilters,
      unavailable: true,
    };
  }

  const { timezone } = report.data.meta;
  const sources = new Set(filters.source);
  const selected: { start: LocalDateHour; value: BlockValue }[] = [];
  let first = span.first;

  for (const block of report.data.blocks.rows) {
    const start = toLocalDateHour(block.start, timezone);
    // The block's end is exclusive: the last date it covers is that of its last millisecond.
    const lastMoment = toLocalDateHour(Date.parse(block.end) - 1, timezone);
    const value = getBlockValueUntil(block, metric, span.last, reader, timezone);

    if (
      start === undefined ||
      lastMoment === undefined ||
      value === undefined ||
      lastMoment.dateKey < span.first ||
      (sources.size > 0 && !sources.has(block.source))
    ) {
      continue;
    }

    selected.push({ start, value });
    first = start.dateKey < first ? start.dateKey : first;
  }

  const days = getDateKeyRange(first, span.last);
  const values = createGrid(days.length);
  const counts = createGrid(days.length);
  const costs =
    metric.kind === 'cost'
      ? days.map(() =>
          Array.from({ length: 24 }, (): ShareCost => ({ costUsd: null, incompleteEvents: 0 })),
        )
      : [];
  const rowOf = new Map(days.map((day, row) => [day, row]));

  for (const { start, value } of selected) {
    const row = rowOf.get(start.dateKey);

    if (row !== undefined) {
      values[row][start.hour] = reader.add(values[row][start.hour], value.value);
      counts[row][start.hour] += 1;

      if (value.cost) {
        costs[row][start.hour] = addCost(costs[row][start.hour], value.cost);
      }
    }
  }

  return { days, values, counts, costs, ignoresFilters, unavailable: false };
}
