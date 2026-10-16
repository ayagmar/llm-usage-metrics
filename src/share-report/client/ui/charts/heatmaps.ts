// Heatmaps: tokens by hour of day and weekday, and the 5-hour blocks by the day and hour they
// start. Five heat levels from the `--heat-*` tokens; the busiest cell is outlined and named in
// words, and every cell has a tooltip.

import {
  buildBlockMatrix,
  buildHourWeekdayMatrix,
  formatUsdOrNone,
  WEEKDAY_LABELS,
} from '../../core/index.js';
import {
  formatCompact,
  formatCount,
  formatDateRange,
  formatDay,
  pluralize,
} from '../shell/format.js';
import { COST_MODE_LABELS } from '../shell/model.js';
import type { ShareViewContext } from '../state/context.js';
import { AXIS_SIZE, caption as captionBlock } from './frame.js';
import { estimateTextWidth, fitText, pickTickSlots } from './layout.js';
import { heatLevel } from './scale.js';
import {
  el,
  round,
  svgRoot,
  text,
  tooltip,
  type ChartTable,
  type ChartView,
  type SvgNode,
} from './svg.js';

function hourLabel(hour: number): string {
  return String(hour).padStart(2, '0');
}

export type HeatGrid = {
  rowLabels: readonly string[];
  /** Column labels; an empty one is never drawn. */
  columnLabels: readonly string[];
  values: readonly (readonly number[])[];
  /** A cell's tooltip. */
  describe: (row: number, column: number) => string;
  /** The tallest a cell may be. */
  maxCell: number;
};

export type HeatPeak = { row: number; column: number; value: number };

/** The largest cell (the first one in reading order on a tie); undefined when all are 0. */
export function findPeak(values: readonly (readonly number[])[]): HeatPeak | undefined {
  let peak: HeatPeak | undefined;

  for (const [row, line] of values.entries()) {
    for (const [column, value] of line.entries()) {
      if (value > 0 && (peak === undefined || value > peak.value)) {
        peak = { row, column, value };
      }
    }
  }

  return peak;
}

/** The grid drawn from `top`; returns its nodes and height. */
export function heatGrid(
  grid: HeatGrid,
  width: number,
  top: number,
): { nodes: SvgNode[]; height: number } {
  const labelWidth =
    Math.ceil(Math.max(0, ...grid.rowLabels.map((label) => estimateTextWidth(label, AXIS_SIZE)))) +
    8;
  const columns = grid.columnLabels.length;
  const cellWidth = (width - labelWidth) / Math.max(columns, 1);
  const cellHeight = Math.min(Math.max(cellWidth, 10), grid.maxCell);
  const gap = cellWidth >= 6 ? 2 : 0;
  const max = Math.max(0, ...grid.values.flat());
  const peak = findPeak(grid.values);
  const gridTop = top + AXIS_SIZE + 6;
  const nodes: SvgNode[] = [];

  for (const slot of pickTickSlots(grid.columnLabels, cellWidth, AXIS_SIZE, 4)) {
    nodes.push(
      text(labelWidth + slot * cellWidth, top + AXIS_SIZE, grid.columnLabels[slot], {
        class: 'chart-tick',
        size: AXIS_SIZE,
      }),
    );
  }

  for (const [row, line] of grid.values.entries()) {
    const y = gridTop + row * cellHeight;

    if (grid.rowLabels[row] !== '') {
      nodes.push(
        text(labelWidth - 8, y + cellHeight / 2 + AXIS_SIZE / 3, grid.rowLabels[row], {
          class: 'chart-tick',
          size: AXIS_SIZE,
          anchor: 'end',
        }),
      );
    }

    for (const [column, value] of line.entries()) {
      nodes.push(
        el(
          'rect',
          {
            x: round(labelWidth + column * cellWidth + gap / 2),
            y: round(y + gap / 2),
            width: round(cellWidth - gap),
            height: round(cellHeight - gap),
            rx: gap > 0 ? 2 : undefined,
            class: `heat-${heatLevel(value, max)}`,
          },
          [tooltip(grid.describe(row, column))],
        ),
      );
    }
  }

  if (peak) {
    nodes.push(
      el('rect', {
        x: round(labelWidth + peak.column * cellWidth),
        y: round(gridTop + peak.row * cellHeight),
        width: round(cellWidth),
        height: round(cellHeight),
        rx: gap > 0 ? 3 : undefined,
        class: 'chart-peak',
      }),
    );
  }

  return { nodes, height: gridTop - top + grid.values.length * cellHeight };
}

/**
 * The level scale under a heatmap, `Less ■■■■■ More`, then the peak in words: beside it when it
 * fits, else on its own line. Returns its nodes and height.
 */
function heatLegend(
  top: number,
  peakText: string,
  width: number,
): { node: SvgNode; height: number } {
  const lessWidth = estimateTextWidth('Less', AXIS_SIZE) + 6;
  const swatches = [0, 1, 2, 3, 4].map((level) =>
    el('rect', {
      x: round(lessWidth + level * 14),
      y: top,
      width: 11,
      height: 11,
      rx: 2,
      class: `heat-${level}`,
    }),
  );
  const moreX = lessWidth + 5 * 14 + 2;
  const besideX = moreX + estimateTextWidth('More', AXIS_SIZE) + 16;
  const beside = besideX + estimateTextWidth(peakText, AXIS_SIZE) <= width;
  const peak = beside
    ? text(besideX, top + 10, peakText, { class: 'chart-value', size: AXIS_SIZE })
    : text(0, top + 28, fitText(peakText, AXIS_SIZE, width), {
        class: 'chart-value',
        size: AXIS_SIZE,
      });

  return {
    node: el('g', {}, [
      text(0, top + 10, 'Less', { class: 'chart-tick', size: AXIS_SIZE }),
      ...swatches,
      text(moreX, top + 10, 'More', { class: 'chart-tick', size: AXIS_SIZE }),
      peak,
    ]),
    height: beside ? 18 : 36,
  };
}

/** Tokens by local hour (columns) and weekday (rows) over the cells with hourly detail. */
export function buildHourWeekdayChart(context: ShareViewContext, width: number): ChartView {
  const { report, cells, span } = context;
  const description = 'Tokens by hour of day and weekday';
  const matrix = buildHourWeekdayMatrix(report, cells, { kind: 'tokens' });
  const notes = [`Hours are local to ${report.data.meta.timezone}.`];

  if (matrix.hourlyFrom !== null) {
    notes.push(`Hourly detail from ${formatDay(matrix.hourlyFrom)}; earlier days are left out.`);
  }

  const hours = Array.from({ length: 24 }, (_, hour) => hourLabel(hour));
  const table: ChartTable = {
    caption: `${description}, in tokens.`,
    columns: [
      { label: 'Weekday', numeric: false },
      ...hours.map((label) => ({ label: `${label}h`, numeric: true })),
      { label: 'Total', numeric: true },
    ],
    rows: matrix.values.map((line, row) => [
      WEEKDAY_LABELS[row],
      ...line.map((value) => (value === 0 ? '0' : formatCompact(value))),
      formatCount(line.reduce((sum, value) => sum + value, 0)),
    ]),
  };
  const peak = findPeak(matrix.values);

  if (span === undefined || peak === undefined) {
    return { description, message: 'No hourly usage in this view.', notes, table };
  }

  const heading = captionBlock(
    `Tokens by hour and weekday · ${formatDateRange(span.first, span.last)}`,
    width,
  );
  const peakText = `Busiest: ${WEEKDAY_LABELS[peak.row]} ${hourLabel(peak.column)}:00, ${formatCompact(peak.value)} tokens`;
  const grid = heatGrid(
    {
      rowLabels: WEEKDAY_LABELS,
      columnLabels: hours,
      values: matrix.values,
      describe: (row, column) =>
        `${WEEKDAY_LABELS[row]} ${hourLabel(column)}:00: ${formatCount(matrix.values[row][column])} tokens`,
      maxCell: 26,
    },
    width,
    heading.height,
  );
  const scale = heatLegend(heading.height + grid.height + 12, peakText, width);

  return {
    description: `${description}. ${peakText}.`,
    svg: svgRoot(width, heading.height + grid.height + 12 + scale.height, description, [
      heading.node,
      el('g', { class: 'chart-heat' }, grid.nodes),
      scale.node,
    ]),
    notes,
    table,
  };
}

/** Up to this many days, a day is a row; past it, a day is a column. */
const DAY_ROWS_MAX = 31;

/**
 * The 5-hour blocks by the local day and hour they start, shaded by their tokens. Blocks run per
 * source, so they keep every model, project and machine; the chart says so when one is filtered.
 */
export function buildBlockChart(context: ShareViewContext, width: number): ChartView {
  const { report, view, span } = context;
  const blockHours = report.data.blocks.blockHours;
  const description = `${blockHours}-hour blocks by the day and hour they start`;

  if (span === undefined) {
    return { description, message: 'No usage in this view.', notes: [] };
  }

  const tokens = buildBlockMatrix(report, view, span, { kind: 'tokens' });
  const mode = view.costMode;
  const costs =
    mode === null || report.data.meta.unavailableCostModes.includes(mode)
      ? undefined
      : buildBlockMatrix(report, view, span, { kind: 'cost', mode });
  const notes = [
    `Each block is shaded by its tokens at the hour it starts, local to ${report.data.meta.timezone}.`,
  ];

  if (tokens.ignoresFilters) {
    notes.unshift('Blocks ignore model, project and machine filters.');
  }

  if (tokens.days[0] < span.first) {
    notes.push(
      `The first row holds blocks that started on ${formatDay(tokens.days[0])} and run into the view.`,
    );
  }

  const rows = tokens.days.flatMap((day, row) =>
    tokens.counts[row].flatMap((count, hour) =>
      count === 0
        ? []
        : [
            [
              `${formatDay(day)} ${hourLabel(hour)}:00`,
              formatCount(count),
              formatCount(tokens.values[row][hour]),
              ...(costs ? [formatUsdOrNone(costs.values[row][hour])] : []),
            ],
          ],
    ),
  );
  const table: ChartTable = {
    caption: `${description}; hours without a block start are left out.`,
    columns: [
      { label: 'Start', numeric: false },
      { label: 'Blocks', numeric: true },
      { label: 'Tokens', numeric: true },
      ...(costs && mode !== null
        ? [{ label: `Cost (${COST_MODE_LABELS[mode].toLowerCase()})`, numeric: true }]
        : []),
    ],
    rows,
  };
  const peak = findPeak(tokens.values);

  if (peak === undefined) {
    return { description, message: 'No blocks start in this view.', notes, table };
  }

  const blockCount = tokens.counts.flat().reduce((sum, count) => sum + count, 0);
  const describe = (row: number, hour: number) => {
    const count = tokens.counts[row][hour];
    return count === 0
      ? `${formatDay(tokens.days[row])} ${hourLabel(hour)}:00: no block starts`
      : `${formatDay(tokens.days[row])} ${hourLabel(hour)}:00: ${pluralize(count, 'block')}, ${formatCount(tokens.values[row][hour])} tokens${costs ? `, ${formatUsdOrNone(costs.values[row][hour])}` : ''}`;
  };
  const dayLabel = (day: string) => formatDay(day).slice(0, -5);
  const hours = Array.from({ length: 24 }, (_, hour) => hourLabel(hour));
  const daysAsRows = tokens.days.length <= DAY_ROWS_MAX;
  const caption = `${pluralize(blockCount, 'block')} · ${formatDateRange(span.first, span.last)}`;
  const heading = captionBlock(caption, width);
  const grid = heatGrid(
    daysAsRows
      ? {
          rowLabels: tokens.days.map(dayLabel),
          columnLabels: hours,
          values: tokens.values,
          describe,
          maxCell: 22,
        }
      : {
          rowLabels: hours.map((label, hour) => (hour % 6 === 0 ? `${label}h` : '')),
          columnLabels: tokens.days.map(dayLabel),
          values: hours.map((_, hour) => tokens.values.map((line) => line[hour])),
          describe: (hour, row) => describe(row, hour),
          maxCell: 9,
        },
    width,
    heading.height,
  );
  const peakRow = daysAsRows ? peak.row : peak.column;
  const peakHour = daysAsRows ? peak.column : peak.row;
  const peakText = `Largest: ${dayLabel(tokens.days[peakRow])} ${hourLabel(peakHour)}:00, ${formatCompact(peak.value)} tokens`;
  const scale = heatLegend(heading.height + grid.height + 12, peakText, width);

  return {
    description: `${description}. ${caption}. ${peakText}.`,
    svg: svgRoot(width, heading.height + grid.height + 12 + scale.height, description, [
      heading.node,
      el('g', { class: 'chart-heat' }, grid.nodes),
      scale.node,
    ]),
    notes,
    table,
  };
}
