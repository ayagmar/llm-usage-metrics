// Ranked breakdowns as labelled horizontal bars: projects by cost (or tokens without one), and
// the model mix as each model's share of tokens next to its share of cost.

import { addUsd } from '../../../../utils/usd-math.js';
import {
  compareText,
  formatUsdOrNone,
  getCost,
  getCostAmount,
  OTHER_SERIES_LABEL,
  rollupByDimension,
  type ShareDimension,
  type ShareDimensionRow,
} from '../../core/index.js';
import { DIMENSION_LABELS } from '../controls/model.js';
import {
  formatCompact,
  formatCount,
  formatDateRange,
  formatPercent,
  pluralize,
} from '../shell/format.js';
import { COST_MODE_LABELS } from '../shell/model.js';
import type { ShareViewContext } from '../state/context.js';
import { caption, LABEL_SIZE, legend, NARROW_WIDTH, type LegendEntry } from './frame.js';
import { estimateTextWidth, fitText } from './layout.js';
import { getSeriesPaint, hatchDefs, paintedRect, type SeriesPaint } from './paint.js';
import {
  el,
  svgRoot,
  text,
  tooltip,
  type ChartTable,
  type ChartView,
  type SvgNode,
} from './svg.js';

/** One ranked row: a label, or the merged remainder with how many it holds. */
export type RankedRow = {
  label: string;
  /** Rows merged into `Other`; 0 for a labelled row. */
  merged: number;
  tokens: number;
  /** The cost in the view's mode; null without one. */
  cost: number | null;
  incompleteEvents: number;
};

/**
 * Totals per label of a dimension, largest `by` first (ties by label), with everything after
 * the first `keep` merged into one `Other` row.
 */
export function rankDimension(
  context: ShareViewContext,
  dimension: ShareDimension,
  by: 'cost' | 'tokens',
  keep: number,
): RankedRow[] {
  const { report, view, cells, labels } = context;
  const mode = view.costMode;
  const toRow = (row: ShareDimensionRow): RankedRow => {
    const cost = mode === null ? undefined : getCost(report, row.costs, mode);

    return {
      label: labels.of(dimension, row.index),
      merged: 0,
      tokens: row.totalTokens,
      cost: cost === undefined ? null : getCostAmount(cost),
      incompleteEvents: cost?.kind === 'value' ? cost.incompleteEvents : 0,
    };
  };
  const measure = (row: RankedRow) => (by === 'cost' ? (row.cost ?? 0) : row.tokens);
  const ranked = rollupByDimension(report, cells, dimension)
    .map(toRow)
    .sort((left, right) => measure(right) - measure(left) || compareText(left.label, right.label));

  if (ranked.length <= keep + 1) {
    return ranked;
  }

  const rest = ranked.slice(keep);
  const other = rest.reduce<RankedRow>(
    (sum, row) => ({
      ...sum,
      tokens: sum.tokens + row.tokens,
      cost:
        sum.cost === null || row.cost === null
          ? (sum.cost ?? row.cost)
          : addUsd(sum.cost, row.cost),
      incompleteEvents: sum.incompleteEvents + row.incompleteEvents,
    }),
    { label: OTHER_SERIES_LABEL, merged: rest.length, tokens: 0, cost: null, incompleteEvents: 0 },
  );

  return [...ranked.slice(0, keep), other];
}

/** A share of a whole: null when the whole is 0. */
export function shareOf(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

function rowLabel(row: RankedRow, dimension: ShareDimension): string {
  return row.merged > 0
    ? `${OTHER_SERIES_LABEL} (${pluralize(row.merged, DIMENSION_LABELS[dimension].one.toLowerCase())})`
    : row.label;
}

/** The cost mode in words, or undefined when the view has no cost to show. */
function costWords(context: ShareViewContext): string | undefined {
  const mode = context.view.costMode;

  return mode === null || context.report.data.meta.unavailableCostModes.includes(mode)
    ? undefined
    : COST_MODE_LABELS[mode].toLowerCase();
}

const ROW_HEIGHT = 28;
const BAR_HEIGHT = 12;

/** Projects ranked by cost in the view's mode, or by tokens when there is no cost. */
export function buildProjectChart(
  chartId: string,
  context: ShareViewContext,
  width: number,
): ChartView {
  const mode = costWords(context);
  const by = mode === undefined ? 'tokens' : 'cost';
  const rows = rankDimension(context, 'project', by, width < NARROW_WIDTH ? 7 : 10);
  const tokenTotal = rows.reduce((sum, row) => sum + row.tokens, 0);
  const costTotal = rows.reduce((sum, row) => addUsd(sum, row.cost ?? 0), 0);
  const value = (row: RankedRow) => (by === 'cost' ? (row.cost ?? 0) : row.tokens);
  const total = by === 'cost' ? costTotal : tokenTotal;
  const description = `Projects by ${by === 'cost' ? `cost (${mode ?? ''})` : 'tokens'}`;
  const notes =
    by === 'tokens' && context.view.costMode !== null
      ? ['Ranked by tokens: this view has no cost to rank by.']
      : [];
  const table: ChartTable = {
    caption: `${description}, largest first.`,
    columns: [
      { label: 'Project', numeric: false },
      { label: 'Tokens', numeric: true },
      ...(mode === undefined ? [] : [{ label: 'Cost', numeric: true }]),
      { label: 'Share', numeric: true },
    ],
    rows: rows.map((row) => [
      rowLabel(row, 'project'),
      formatCount(row.tokens),
      ...(mode === undefined ? [] : [costText(row)]),
      formatPercent(shareOf(value(row), total)),
    ]),
  };

  if (total <= 0) {
    return {
      description,
      message: by === 'cost' ? 'No priced usage in this view.' : 'No tokens in this view.',
      notes,
      table,
    };
  }

  const format = (amount: number) =>
    by === 'cost' ? formatUsdOrNone(amount) : formatCompact(amount);
  const max = Math.max(...rows.map(value));
  const valueTexts = rows.map(
    (row) => `${format(value(row))} · ${formatPercent(shareOf(value(row), total))}`,
  );
  const heading = caption(
    `${description} · ${spanWords(context)} · ${format(total)} in total`,
    width,
  );
  // Narrow: the label gets its own line over the bar; wide: a label column left of the bars.
  const stacked = width < NARROW_WIDTH;
  const rowHeight = stacked ? ROW_HEIGHT + 14 : ROW_HEIGHT;
  const labelWidth = stacked ? width : Math.min(width * 0.36, 260);
  const valueWidth =
    Math.max(...valueTexts.map((entry) => estimateTextWidth(entry, LABEL_SIZE))) + 8;
  const barLeft = stacked ? 0 : labelWidth + 8;
  const barRoom = Math.max(width - barLeft - valueWidth, 20);
  const nodes = rows.map((row, index) => {
    const y = heading.height + index * rowHeight;
    const barY = stacked ? y + 16 : y;
    const barWidth = Math.max((barRoom * value(row)) / max, value(row) > 0 ? 1 : 0);
    const label = rowLabel(row, 'project');

    return el('g', {}, [
      tooltip(`${label}: ${valueTexts[index]}`),
      text(0, y + BAR_HEIGHT - 1, fitText(label, LABEL_SIZE, labelWidth), {
        class: 'chart-label',
        size: LABEL_SIZE,
      }),
      paintedRect(getSeriesPaint(chartId, row.merged > 0 ? 'other' : 0), {
        x: barLeft,
        y: barY + 1,
        width: barWidth,
        height: BAR_HEIGHT,
      }),
      text(barLeft + barWidth + 6, barY + BAR_HEIGHT - 1, valueTexts[index], {
        class: 'chart-value',
        size: LABEL_SIZE,
      }),
    ]);
  });

  return {
    description: `${description}, ${spanWords(context)}, ${format(total)} in total.`,
    svg: svgRoot(width, heading.height + rows.length * rowHeight, description, [
      heading.node,
      el('g', { class: 'chart-bars' }, nodes),
    ]),
    notes,
    table,
  };
}

function costText(row: RankedRow): string {
  if (row.cost === null) {
    return formatUsdOrNone(null);
  }

  return `${row.incompleteEvents > 0 ? '~' : ''}${formatUsdOrNone(row.cost)}`;
}

function spanWords(context: ShareViewContext): string {
  return context.span ? formatDateRange(context.span.first, context.span.last) : '';
}

const MIX_ROW = 50;

/** Each model's share of tokens and, with a cost, its share of cost, as two labelled bars. */
export function buildModelMixChart(
  chartId: string,
  context: ShareViewContext,
  width: number,
): ChartView {
  const mode = costWords(context);
  const rows = rankDimension(context, 'model', 'tokens', width < NARROW_WIDTH ? 6 : 8);
  const tokenTotal = rows.reduce((sum, row) => sum + row.tokens, 0);
  const costTotal = rows.reduce((sum, row) => addUsd(sum, row.cost ?? 0), 0);
  const withCost = mode !== undefined && costTotal > 0;
  const description = withCost
    ? `Model mix: each model's share of tokens and of cost (${mode})`
    : "Model mix: each model's share of tokens";
  const table: ChartTable = {
    caption: `${description}, by tokens, largest first.`,
    columns: [
      { label: 'Model', numeric: false },
      { label: 'Tokens', numeric: true },
      { label: 'Share of tokens', numeric: true },
      ...(withCost
        ? [
            { label: 'Cost', numeric: true },
            { label: 'Share of cost', numeric: true },
          ]
        : []),
    ],
    rows: rows.map((row) => [
      rowLabel(row, 'model'),
      formatCount(row.tokens),
      formatPercent(shareOf(row.tokens, tokenTotal)),
      ...(withCost ? [costText(row), formatPercent(shareOf(row.cost ?? 0, costTotal))] : []),
    ]),
  };

  if (tokenTotal <= 0) {
    return { description, message: 'No tokens in this view.', notes: [], table };
  }

  const tokenPaint = getSeriesPaint(chartId, 1);
  const costPaint = getSeriesPaint(chartId, 0);
  const entries: LegendEntry[] = [
    { label: 'Share of tokens', value: '', paint: tokenPaint },
    ...(withCost ? [{ label: 'Share of cost', value: '', paint: costPaint }] : []),
  ];
  const heading = caption(
    `${withCost ? 'Share of tokens and cost' : 'Share of tokens'} by model · ${spanWords(context)}`,
    width,
  );
  const legendBlock = legend(entries, width, heading.height);
  const top = heading.height + legendBlock.height + 6;
  const rowHeight = withCost ? MIX_ROW : MIX_ROW - 14;
  const barRoom = Math.max(width - estimateTextWidth('100.0% of tokens', LABEL_SIZE) - 8, 40);
  const bar = (paint: SeriesPaint, share: number | null, y: number, what: string): SvgNode[] => {
    const barWidth = Math.max(barRoom * (share ?? 0), (share ?? 0) > 0 ? 1 : 0);

    return [
      paintedRect(paint, { x: 0, y, width: barWidth, height: 9 }),
      text(barWidth + 6, y + 9, `${formatPercent(share)} of ${what}`, {
        class: 'chart-value',
        size: LABEL_SIZE,
      }),
    ];
  };
  const nodes = rows.map((row, index) => {
    const y = top + index * rowHeight;
    const label = rowLabel(row, 'model');
    const tokenShare = shareOf(row.tokens, tokenTotal);
    const costShare = shareOf(row.cost ?? 0, costTotal);

    return el('g', {}, [
      tooltip(
        withCost
          ? `${label}: ${formatPercent(tokenShare)} of tokens, ${formatPercent(costShare)} of cost`
          : `${label}: ${formatPercent(tokenShare)} of tokens`,
      ),
      text(0, y + LABEL_SIZE, fitText(label, LABEL_SIZE, width), {
        class: 'chart-label',
        size: LABEL_SIZE,
      }),
      ...bar(tokenPaint, tokenShare, y + 18, 'tokens'),
      ...(withCost ? bar(costPaint, costShare, y + 32, 'cost') : []),
    ]);
  });
  return {
    description: `${description}, ${spanWords(context)}.`,
    svg: svgRoot(width, top + rows.length * rowHeight, description, [
      hatchDefs(entries.map((entry) => entry.paint)),
      heading.node,
      legendBlock.node,
      el('g', { class: 'chart-bars' }, nodes),
    ]),
    notes: [],
    table,
  };
}
