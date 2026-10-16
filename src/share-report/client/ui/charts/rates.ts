// Ratios over time as lines: the cache hit rate, and cost per active hour. A period without a
// denominator leaves a gap in the line, never a zero; the whole view's ratio is a labelled
// dashed line across.

import {
  formatUsdOrNone,
  getCacheHitRate,
  getCost,
  getCostPerActiveHour,
  getPeriodAxis,
  rollupByPeriod,
  selectHourlyCells,
  sumCells,
  type ShareDateSpan,
  type ShareTotals,
} from '../../core/index.js';
import { formatDateRange, formatDay, formatPercent } from '../shell/format.js';
import { COST_MODE_LABELS } from '../shell/model.js';
import type { ShareViewContext } from '../state/context.js';
import {
  AXIS_SIZE,
  caption,
  formatAxisValue,
  formatPeriod,
  LABEL_SIZE,
  NARROW_WIDTH,
  X_AXIS_HEIGHT,
  xAxis,
  yAxis,
  yAxisWidth,
} from './frame.js';
import { estimateTextWidth } from './layout.js';
import { bandScale, linearScale } from './scale.js';
import { el, round, svgRoot, text, tooltip, type ChartView, type SvgNode } from './svg.js';

export type Point = { x: number; y: number };

/**
 * An SVG path through the points in order, broken wherever a point is missing; a point with no
 * neighbour on either side draws nothing here (the chart marks it with a dot).
 */
export function linePath(points: readonly (Point | null)[]): string {
  const parts: string[] = [];
  let drawing = false;

  for (const [index, point] of points.entries()) {
    if (point === null) {
      drawing = false;
      continue;
    }

    const next = points[index + 1] ?? null;

    if (!drawing && next === null) {
      continue;
    }

    parts.push(`${drawing ? 'L' : 'M'}${round(point.x)} ${round(point.y)}`);
    drawing = true;
  }

  return parts.join('');
}

/** Dots on every point when they fit, else only on points the line cannot show. */
export function dotSlots(values: readonly (number | null)[], slotWidth: number): number[] {
  return values.flatMap((value, slot) => {
    if (value === null) {
      return [];
    }

    const alone = (values[slot - 1] ?? null) === null && (values[slot + 1] ?? null) === null;
    return slotWidth >= 10 || alone ? [slot] : [];
  });
}

type LineSpec = {
  description: string;
  caption: string;
  axis: readonly string[];
  values: readonly (number | null)[];
  overall: number | null;
  /** The y domain's top; the line's own maximum when undefined. */
  max?: number;
  format: (value: number | null) => string;
  tickFormat: (value: number) => string;
  context: ShareViewContext;
  width: number;
  notes: string[];
  valueColumn: string;
};

function buildLineChart(spec: LineSpec): ChartView {
  const { view } = spec.context;
  const periods = spec.axis.map((key) => formatPeriod(key, view.granularity));
  const table = {
    caption: `${spec.description}; periods without a value are left out.`,
    columns: [
      { label: 'Period', numeric: false },
      { label: spec.valueColumn, numeric: true },
    ],
    rows: spec.values.flatMap((value, slot) =>
      value === null ? [] : [[periods[slot].long, spec.format(value)]],
    ),
    total: ['Whole view', spec.format(spec.overall)],
  };
  const present = spec.values.filter((value): value is number => value !== null);

  if (present.length === 0 || spec.overall === null) {
    return {
      description: spec.description,
      message: 'Nothing to measure in this view.',
      notes: spec.notes,
    };
  }

  const heading = caption(spec.caption, spec.width);
  const top = heading.height;
  const plotHeight = spec.width < NARROW_WIDTH ? 170 : 210;
  const scale = linearScale(spec.max ?? Math.max(...present, spec.overall), [
    top + plotHeight,
    top + 30,
  ]);
  const plot = { left: yAxisWidth(scale, spec.tickFormat), right: spec.width };
  const band = bandScale(spec.axis.length, [plot.left, plot.right], 0);
  const points = spec.values.map((value, slot) =>
    value === null ? null : { x: band.at(slot) + band.step / 2, y: scale.at(value) },
  );
  const overallY = round(scale.at(spec.overall));
  // The key for the whole-view line sits above the plot, never on the line it explains.
  const overallText = `Whole view ${spec.format(spec.overall)}`;
  const keyLeft = Math.max(plot.left, plot.right - estimateTextWidth(overallText, LABEL_SIZE) - 26);
  const dots: SvgNode[] = dotSlots(spec.values, band.step).flatMap((slot) => {
    const point = points[slot];

    return point === null
      ? []
      : [
          el('circle', { cx: round(point.x), cy: round(point.y), r: 3, class: 'chart-dot' }, [
            tooltip(`${periods[slot].long}: ${spec.format(spec.values[slot])}`),
          ]),
        ];
  });

  return {
    description: `${spec.description}. ${spec.caption}.`,
    svg: svgRoot(spec.width, top + plotHeight + X_AXIS_HEIGHT, spec.description, [
      heading.node,
      yAxis(scale, plot, spec.tickFormat),
      el('line', {
        x1: plot.left,
        x2: plot.right,
        y1: overallY,
        y2: overallY,
        class: 'chart-reference',
      }),
      el('line', {
        x1: round(keyLeft),
        x2: round(keyLeft + 18),
        y1: top + 14,
        y2: top + 14,
        class: 'chart-reference',
      }),
      text(keyLeft + 24, top + 18, overallText, {
        class: 'chart-reference-label',
        size: LABEL_SIZE,
      }),
      el('path', { d: linePath(points), class: 'chart-line' }),
      el('g', {}, dots),
      xAxis(
        periods.map((period) => period.short),
        band,
        plot,
        top + plotHeight + AXIS_SIZE + 6,
      ),
    ]),
    notes: spec.notes,
    table,
  };
}

function valuesByAxis(
  axis: readonly string[],
  rows: readonly (ShareTotals & { key: string })[],
  measure: (row: ShareTotals) => number | null,
): (number | null)[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));

  return axis.map((key) => {
    const row = byKey.get(key);
    return row === undefined ? null : measure(row);
  });
}

/** Cache reads as a share of all prompt tokens, per period. */
export function buildCacheHitChart(context: ShareViewContext, width: number): ChartView {
  const { report, view, cells, span } = context;
  const description = `Cache hit rate per ${view.granularity}`;

  if (span === undefined) {
    return { description, message: 'No usage in this view.', notes: [] };
  }

  const axis = getPeriodAxis(report, span, view.granularity);
  const rollup = rollupByPeriod(report, cells, view.granularity);
  const overall = getCacheHitRate(sumCells(report, cells));
  const notes = ['Cache reads as a share of input, cache read and cache write tokens.'];

  if (rollup.hourlyFrom !== null) {
    notes.push(
      `Hourly detail from ${formatDay(rollup.hourlyFrom)}; the whole-view line covers every day.`,
    );
  }

  return buildLineChart({
    description,
    caption: `Cache hit rate per ${view.granularity} · ${formatDateRange(span.first, span.last)} · ${formatPercent(overall)} overall`,
    axis,
    values: valuesByAxis(axis, rollup.rows, getCacheHitRate),
    overall,
    max: 1,
    format: formatPercent,
    tickFormat: (value) => `${Math.round(value * 100)}%`,
    context,
    width,
    notes,
    valueColumn: 'Cache hit rate',
  });
}

/**
 * Cost per active hour, per period, over the cells with hourly detail: active time is only
 * measured per hour, so earlier days are left out and the chart says so.
 */
export function buildCostPerHourChart(context: ShareViewContext, width: number): ChartView {
  const { report, view, cells, span } = context;
  const mode = view.costMode;
  const description = `Cost per active hour, per ${view.granularity}`;

  if (mode === null) {
    return {
      description,
      message: 'This file holds no cost: it was made with --no-cost.',
      notes: [],
    };
  }

  if (report.data.meta.unavailableCostModes.includes(mode)) {
    return {
      description,
      message: 'Prices could not be loaded for this cost mode, so there is no cost to draw.',
      notes: [],
    };
  }

  if (span === undefined) {
    return { description, message: 'No usage in this view.', notes: [] };
  }

  const { hourlyFrom } = report.data.meta;
  const notes = [
    'Approximate: active time caps idle gaps at 5 minutes, so it can differ slightly from trends --metric active-hours.',
  ];

  if (hourlyFrom !== null && hourlyFrom > span.first) {
    notes.push(`Hourly detail from ${formatDay(hourlyFrom)}; earlier days are left out.`);
  }

  if (hourlyFrom !== null && hourlyFrom > span.last) {
    return {
      description,
      message: `This period has no hourly detail: it starts on ${formatDay(hourlyFrom)}.`,
      notes,
    };
  }

  const clipped: ShareDateSpan =
    hourlyFrom !== null && hourlyFrom > span.first ? { first: hourlyFrom, last: span.last } : span;
  const hourlyCells = selectHourlyCells(report, cells);
  const perHour = (totals: ShareTotals) => {
    const cost = getCost(report, totals.costs, mode);
    return cost.kind === 'value' ? getCostPerActiveHour(cost.costUsd, totals.activeMs) : null;
  };
  const axis = getPeriodAxis(report, clipped, view.granularity);
  const overall = perHour(sumCells(report, hourlyCells));

  return buildLineChart({
    description,
    caption: `Cost (${COST_MODE_LABELS[mode].toLowerCase()}) per active hour · ${formatDateRange(clipped.first, clipped.last)} · ${formatUsdOrNone(overall)} overall`,
    axis,
    values: valuesByAxis(axis, rollupByPeriod(report, hourlyCells, view.granularity).rows, perHour),
    overall,
    format: formatUsdOrNone,
    tickFormat: (value) => formatAxisValue(value, 'usd'),
    context,
    width,
    notes,
    valueColumn: 'Cost per active hour',
  });
}
