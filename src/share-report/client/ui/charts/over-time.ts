// Cost and tokens over time: one stacked bar per period of the view, one layer per source,
// model, project or machine (the view's "Stack by"), the largest at the bottom.

import { addUsd } from '../../../../utils/usd-math.js';
import {
  getPeriodAxis,
  OTHER_SERIES_LABEL,
  stackByDimension,
  sumCells,
  formatUsdOrNone,
  type ShareMetric,
} from '../../core/index.js';
import { DIMENSION_LABELS } from '../controls/model.js';
import { formatDateRange, formatDay } from '../shell/format.js';
import { COST_MODE_LABELS } from '../shell/model.js';
import type { ShareViewContext } from '../state/context.js';
import {
  AXIS_SIZE,
  caption as captionBlock,
  formatAxisValue,
  usdTickFormat,
  formatPeriod,
  legend,
  NARROW_WIDTH,
  seriesLegend,
  X_AXIS_HEIGHT,
  xAxis,
  yAxis,
  yAxisWidth,
} from './frame.js';
import { hatchDefs, paintedRect, SERIES_COLOURS } from './paint.js';
import { bandScale, linearScale } from './scale.js';
import { el, svgRoot, tooltip, type ChartView } from './svg.js';
import { pluralize } from '../../../../../packages/core/src/utils/pluralize.js';
import { formatInteger } from '../../../../render/format-number.js';

export type OverTimeMetric = 'cost' | 'tokens';

const GRANULARITY_WORDS = { hour: 'hour', day: 'day', week: 'week', month: 'month' } as const;

/** Why there is no cost to draw, or the metric to draw. */
function resolveMetric(
  context: ShareViewContext,
  metric: OverTimeMetric,
): { metric: ShareMetric } | { message: string } {
  if (metric === 'tokens') {
    return { metric: { kind: 'tokens' } };
  }

  const mode = context.view.costMode;

  if (mode === null) {
    return { message: 'This file holds no cost: it was made with --no-cost.' };
  }

  if (context.report.data.meta.unavailableCostModes.includes(mode)) {
    return {
      message: 'Prices could not be loaded for this cost mode, so there is no cost to draw.',
    };
  }

  return { metric: { kind: 'cost', mode } };
}

export function buildOverTimeChart(
  chartId: string,
  metricName: OverTimeMetric,
  context: ShareViewContext,
  width: number,
): ChartView {
  const { report, view, cells, span, labels } = context;
  const dimension = view.stackBy;
  const dimensionWords = DIMENSION_LABELS[dimension];
  const resolved = resolveMetric(context, metricName);
  const metricWords =
    metricName === 'tokens'
      ? 'Tokens'
      : `Cost${view.costMode === null ? '' : ` (${COST_MODE_LABELS[view.costMode].toLowerCase()})`}`;
  const description = `${metricWords} per ${GRANULARITY_WORDS[view.granularity]}, stacked by ${dimensionWords.one.toLowerCase()}`;

  if ('message' in resolved || span === undefined) {
    return {
      description,
      message: 'message' in resolved ? resolved.message : 'No usage in this view.',
      notes: [],
    };
  }

  const unit = metricName === 'tokens' ? 'tokens' : 'usd';
  const add = unit === 'usd' ? addUsd : (left: number, right: number) => left + right;
  const format = (value: number) => formatAxisValue(value, unit);
  const exact = (value: number) => (unit === 'usd' ? formatUsdOrNone(value) : formatInteger(value));
  const axis = getPeriodAxis(report, span, view.granularity);
  const stack = stackByDimension(report, cells, {
    axis,
    granularity: view.granularity,
    dimension,
    metric: resolved.metric,
    maxSeries: SERIES_COLOURS,
  });
  const totals = axis.map((_, slot) =>
    stack.series.reduce((sum, series) => add(sum, series.values[slot]), 0),
  );
  const grandTotal = totals.reduce(add, 0);
  const notes: string[] = [];
  const { hourlyFrom } = report.data.meta;

  if (view.granularity === 'hour' && hourlyFrom !== null && hourlyFrom > span.first) {
    notes.push(`Hourly detail from ${formatDay(hourlyFrom)}; earlier days have daily totals only.`);
  }

  if (resolved.metric.kind === 'cost') {
    const incomplete = sumCells(report, cells).costs[resolved.metric.mode]?.incompleteEvents ?? 0;

    if (incomplete > 0) {
      notes.push(
        `${pluralize(incomplete, 'event')} had no price, so these costs are lower bounds.`,
      );
    }
  }

  if (stack.series.some((series) => series.index === null)) {
    notes.push(
      `${OTHER_SERIES_LABEL} merges every ${dimensionWords.one.toLowerCase()} after the largest ${SERIES_COLOURS}.`,
    );
  }

  if (grandTotal <= 0) {
    return {
      description,
      message: unit === 'usd' ? 'No priced usage in this view.' : 'No tokens in this view.',
      notes,
    };
  }

  const seriesLabels = stack.series.map((series) =>
    series.index === null ? OTHER_SERIES_LABEL : labels.of(dimension, series.index),
  );
  const periods = axis.map((key) => formatPeriod(key, view.granularity));
  const caption = `${metricWords} by ${dimensionWords.one.toLowerCase()}, per ${GRANULARITY_WORDS[view.granularity]} · ${formatDateRange(span.first, span.last)} · ${exact(grandTotal)} in total`;
  const entries = seriesLegend(
    chartId,
    stack.series.map((series, slot) => ({
      label: seriesLabels[slot],
      other: series.index === null,
      value: format(series.total),
    })),
  );
  const heading = captionBlock(caption, width);
  const top = heading.height;
  const legendBlock = legend(entries, width, top);
  const plotTop = top + legendBlock.height + 10;
  const plotHeight = width < NARROW_WIDTH ? 170 : 230;
  const scale = linearScale(Math.max(...totals), [plotTop + plotHeight, plotTop]);
  const tickFormat = unit === 'usd' ? usdTickFormat(scale.step) : format;
  const plot = { left: yAxisWidth(scale, tickFormat), right: width };
  const band = bandScale(axis.length, [plot.left, plot.right], 0.2, 64);
  const bars = axis.flatMap((_, slot) => {
    let base = 0;

    return stack.series.flatMap((series, layer) => {
      const value = series.values[slot];

      if (value <= 0) {
        return [];
      }

      const y0 = scale.at(base);
      base = add(base, value);
      const y1 = scale.at(base);

      return [
        paintedRect(
          entries[layer].paint,
          { x: band.at(slot), y: y1, width: band.bandwidth, height: Math.max(y0 - y1, 0.5) },
          tooltip(`${periods[slot].long} · ${seriesLabels[layer]}: ${exact(value)}`),
        ),
      ];
    });
  });
  const height = plotTop + plotHeight + X_AXIS_HEIGHT;

  return {
    description: `${description}. ${caption}.`,
    svg: svgRoot(width, height, `${description}, ${formatDateRange(span.first, span.last)}`, [
      hatchDefs(entries.map((entry) => entry.paint)),
      heading.node,
      legendBlock.node,
      yAxis(scale, plot, tickFormat),
      el('g', { class: 'chart-bars' }, bars),
      xAxis(
        periods.map((period) => period.short),
        band,
        plot,
        plotTop + plotHeight + AXIS_SIZE + 6,
      ),
    ]),
    notes,
    table: {
      caption: `${metricWords} by ${dimensionWords.one.toLowerCase()} and ${GRANULARITY_WORDS[view.granularity]}; periods without usage are left out.`,
      columns: [
        { label: 'Period', numeric: false },
        ...seriesLabels.map((label) => ({ label, numeric: true })),
        { label: 'Total', numeric: true },
      ],
      rows: axis.flatMap((_, slot) =>
        totals[slot] > 0
          ? [
              [
                periods[slot].long,
                ...stack.series.map((series) => exact(series.values[slot])),
                exact(totals[slot]),
              ],
            ]
          : [],
      ),
      total: ['Total', ...stack.series.map((series) => exact(series.total)), exact(grandTotal)],
    },
  };
}
