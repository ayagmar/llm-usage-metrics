// The parts every chart shares: type sizes, the caption line, the legend, the axes and how
// periods and values read on them.

import { MONTH_LABELS } from '../../../../render/month-labels.js';
import type { ShareGranularity } from '../../../types.js';
import { formatUsdOrNone } from '../../core/index.js';
import { formatDay } from '../shell/format.js';
import {
  estimateTextWidth,
  fitText,
  layoutLegend,
  pickTickSlots,
  placeAxisLabels,
  type LegendItem,
} from './layout.js';
import { getSeriesPaint, paintedRect, type SeriesPaint } from './paint.js';
import type { BandScale, LinearScale } from './scale.js';
import { el, round, text, type SvgNode } from './svg.js';
import { formatAbbreviatedTokenCount } from '../../../../render/format-number.js';

/** Axis ticks and small print. */
export const AXIS_SIZE = 11;
/** Captions, legends and direct labels. */
export const LABEL_SIZE = 12;
/** Below this width a chart uses its compact layout. */
export const NARROW_WIDTH = 480;

const LEGEND_ROW = 20;
const SWATCH = 10;

/** How a period key reads: `short` on an axis, `long` in tooltips and tables. */
export function formatPeriod(
  key: string,
  granularity: ShareGranularity,
): { short: string; long: string } {
  switch (granularity) {
    case 'hour': {
      const day = formatDay(key.slice(0, 10));
      const time = key.slice(11);
      return { short: `${day.slice(0, -5)} ${time}`, long: `${day} ${time}` };
    }
    case 'day':
      return { short: formatDay(key).slice(0, -5), long: formatDay(key) };
    case 'week':
      // `2026-W43`
      return { short: key.slice(5), long: `Week ${Number(key.slice(6))}, ${key.slice(0, 4)}` };
    case 'month': {
      const name = MONTH_LABELS[Number(key.slice(5, 7)) - 1] ?? key;
      return { short: `${name} ${key.slice(2, 4)}`, long: `${name} ${key.slice(0, 4)}` };
    }
  }
}

/** `24.3K` tokens or `$1.23` on an axis and in a legend. */
export function formatAxisValue(value: number, unit: 'tokens' | 'usd'): string {
  if (unit === 'tokens') {
    return formatAbbreviatedTokenCount(value);
  }

  return value >= 1000 ? `$${formatAbbreviatedTokenCount(value)}` : formatUsdOrNone(value);
}

/** The decimals a step needs to be written exactly (a nice step has few). */
function stepDecimals(step: number): number {
  let decimals = 0;
  let scaled = step;

  while (decimals < 12 && Math.abs(Math.round(scaled) - scaled) > 1e-9 * scaled) {
    decimals += 1;
    scaled = step * 10 ** decimals;
  }

  return decimals;
}

/**
 * One format for every tick of a cost axis, chosen from its step: `$2K` when the step is $1,000
 * or more, whole dollars for a whole-dollar step, else at least cents and as many decimals as
 * the step needs, so no two ticks read alike.
 */
export function usdTickFormat(step: number): (value: number) => string {
  if (step >= 1000) {
    return (value) => `$${formatAbbreviatedTokenCount(value)}`;
  }

  const decimals = step >= 1 && Number.isInteger(step) ? 0 : Math.max(2, stepDecimals(step));
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (value) => formatter.format(value);
}

const CAPTION_LINE = 16;

/**
 * Splits a caption into lines that fit `width`, breaking only between its ` · ` parts; a part
 * wider than a whole line is shortened.
 */
export function wrapCaption(content: string, width: number): string[] {
  const lines: string[] = [];

  for (const part of content.split(' · ')) {
    const joined = lines.length === 0 ? part : `${lines[lines.length - 1]} · ${part}`;

    if (lines.length > 0 && estimateTextWidth(joined, LABEL_SIZE) <= width) {
      lines[lines.length - 1] = joined;
    } else {
      lines.push(fitText(part, LABEL_SIZE, width));
    }
  }

  return lines;
}

/**
 * The caption at the top of the drawing: what it shows, so an exported image says it. Returns
 * its nodes and the height to leave above what follows.
 */
export function caption(content: string, width: number): { node: SvgNode; height: number } {
  const lines = wrapCaption(content, width);

  return {
    node: el(
      'g',
      {},
      lines.map((line, index) =>
        text(0, LABEL_SIZE + index * CAPTION_LINE, line, {
          class: 'chart-caption',
          size: LABEL_SIZE,
        }),
      ),
    ),
    height: lines.length * CAPTION_LINE + 10,
  };
}

export type LegendEntry = LegendItem & { paint: SeriesPaint };

/** The legend under the caption, from `top`; returns its nodes and height. */
export function legend(
  entries: readonly LegendEntry[],
  width: number,
  top: number,
): { node: SvgNode; height: number } {
  const layout = layoutLegend(entries, width, { size: LABEL_SIZE, swatch: SWATCH, gap: 16 });
  const nodes = layout.items.map((item, index) => {
    const y = top + item.row * LEGEND_ROW;

    return el('g', { class: 'chart-legend-item' }, [
      paintedRect(entries[index].paint, { x: item.x, y: y + 2, width: SWATCH, height: SWATCH }),
      text(item.x + SWATCH + 6, y + 11, item.text, { class: 'chart-legend', size: LABEL_SIZE }),
    ]);
  });

  return { node: el('g', {}, nodes), height: layout.rows * LEGEND_ROW };
}

/** Legend entries for stacked series, in stack order. */
export function seriesLegend(
  chartId: string,
  series: readonly { label: string; other: boolean; value: string }[],
): LegendEntry[] {
  return series.map((entry, slot) => ({
    label: entry.label,
    value: entry.value,
    paint: getSeriesPaint(chartId, entry.other ? 'other' : slot),
  }));
}

/** The width the y axis labels need. */
export function yAxisWidth(scale: LinearScale, format: (value: number) => string): number {
  return (
    Math.ceil(Math.max(...scale.ticks.map((tick) => estimateTextWidth(format(tick), AXIS_SIZE)))) +
    8
  );
}

/** Horizontal grid lines with their values at the left of the plot. */
export function yAxis(
  scale: LinearScale,
  plot: { left: number; right: number },
  format: (value: number) => string,
): SvgNode {
  return el(
    'g',
    { class: 'chart-axis' },
    scale.ticks.flatMap((tick) => {
      const y = round(scale.at(tick));

      return [
        el('line', {
          x1: round(plot.left),
          x2: round(plot.right),
          y1: y,
          y2: y,
          class: tick === 0 ? 'chart-baseline' : 'chart-grid',
        }),
        text(plot.left - 8, y + AXIS_SIZE / 3, format(tick), {
          class: 'chart-tick',
          size: AXIS_SIZE,
          anchor: 'end',
        }),
      ];
    }),
  );
}

/**
 * Period labels under the bands, thinned so none overlap, and kept inside the plot's ends so the
 * first and last never spill past the drawing.
 */
export function xAxis(
  labels: readonly string[],
  band: BandScale,
  plot: { left: number; right: number },
  y: number,
): SvgNode {
  return el(
    'g',
    { class: 'chart-axis' },
    placeAxisLabels(
      labels,
      pickTickSlots(labels, band.step, AXIS_SIZE),
      (slot) => band.at(slot) + band.bandwidth / 2,
      plot,
      AXIS_SIZE,
    ).map(({ slot, x }) =>
      text(x, y, labels[slot], { class: 'chart-tick', size: AXIS_SIZE, anchor: 'middle' }),
    ),
  );
}

/** The height the x axis labels take under the plot. */
export const X_AXIS_HEIGHT = AXIS_SIZE + 10;
