// The words around the data: the report's title and facts, its badges, the summary figures
// and the empty states. Pure; `render.ts` lays them out.

import type { ShareCostMode, ShareReportMeta } from '../../../types.js';
import { getReportTitle } from '../export/share-document.js';
import {
  formatUsdOrNone,
  getCacheHitRate,
  getCost,
  getCostPerActiveHour,
  resolveUntil,
  selectHourlyCells,
  sumCells,
  type ShareReport,
} from '../../core/index.js';
import type { ShareLabels, ShareViewContext } from '../state/context.js';
import { hasLabelFilters } from '../state/view.js';
import {
  formatCompact,
  formatCost,
  formatCount,
  formatDateRange,
  formatDay,
  formatDuration,
  formatPercent,
  formatTimestamp,
} from './format.js';

/** The `--cost-mode` names, as the CLI spells them. */
export const COST_MODE_LABELS: Record<ShareCostMode, string> = {
  explicit: 'Explicit',
  estimated: 'Estimated',
  both: 'Both',
};

/** What each mode counts, as `--cost-mode` help puts it. */
export const COST_MODE_DETAILS: Record<ShareCostMode, string> = {
  explicit: 'Logged by the source',
  estimated: 'Estimated from prices',
  both: 'Logged, else estimated',
};

export type Badge = { text: string; tone: 'neutral' | 'notice' };

export type HeaderView = {
  title: string;
  /** The period the view shows. */
  period: string;
  facts: string[];
  badges: Badge[];
};

/** The command's own filters; machine names go through "Hide names" like every label. */
function describeCommandFilters(
  filters: ShareReportMeta['filters'],
  labels: ShareLabels,
): string | undefined {
  const lists: [string, string[]][] = [
    ['source', filters.sources],
    ['provider', filters.providers],
    ['model', filters.models],
    ['machine', filters.machines.map(labels.machine)],
  ];
  const parts = lists.flatMap(([name, values]) =>
    values.length === 0 ? [] : [`${name} ${values.join(', ')}`],
  );

  if (filters.repo) {
    parts.push('selected repositories');
  }

  return parts.length === 0 ? undefined : `Generated for ${parts.join('; ')}`;
}

export function buildHeader(context: ShareViewContext): HeaderView {
  const { meta } = context.report.data;
  const facts = [
    `From llm-usage ${meta.command}`,
    // `All dates`, `Up to …` and `From …` continue the sentence in lower case.
    `File covers ${formatDateRange(meta.window.since, resolveUntil(context.report, meta.window.until)).replace(/^[AUF](?=[a-z])/u, (letter) => letter.toLowerCase())}`,
    `Times in ${meta.timezone}`,
    `Generated ${formatTimestamp(meta.generatedAt, meta.timezone)}`,
    `llm-usage-metrics ${meta.toolVersion}`,
  ];
  const badges: Badge[] = [
    meta.redacted
      ? { text: 'Redacted', tone: 'neutral' }
      : { text: 'Shows project and machine names', tone: 'notice' },
  ];

  if (context.labels.hidden) {
    badges.push({ text: 'Names hidden on screen', tone: 'neutral' });
  }

  const commandFilters = describeCommandFilters(meta.filters, context.labels);

  if (commandFilters) {
    badges.push({ text: commandFilters, tone: 'neutral' });
  }

  if (meta.costMode === null) {
    badges.push({ text: 'No cost data', tone: 'neutral' });
  } else if (meta.unavailableCostModes.length > 0) {
    badges.push({
      text: `Prices unavailable: ${meta.unavailableCostModes.map((mode) => COST_MODE_LABELS[mode].toLowerCase()).join(', ')}`,
      tone: 'notice',
    });
  }

  if (meta.hourlyFrom !== null) {
    badges.push({ text: `Hourly detail from ${formatDay(meta.hourlyFrom)}`, tone: 'neutral' });
  }

  return {
    title: getReportTitle(meta),
    period: formatDateRange(context.view.since, resolveUntil(context.report, context.view.until)),
    facts,
    badges,
  };
}

export type SummaryFigure = {
  id: string;
  label: string;
  value: string;
  /** A second line: the exact figure, or what the value means. */
  detail: string;
};

/** The summary row over the view: tokens, cost, events, active time and the two ratios. */
export function buildSummary(context: ShareViewContext): SummaryFigure[] {
  const { report, view, cells } = context;
  const totals = sumCells(report, cells);
  const figures: SummaryFigure[] = [
    {
      id: 'tokens',
      label: 'Tokens',
      value: formatCompact(totals.totalTokens),
      detail: `${formatCount(totals.totalTokens)} in total`,
    },
  ];

  if (view.costMode !== null) {
    const cost = formatCost(getCost(report, totals.costs, view.costMode));
    figures.push({
      id: 'cost',
      label: 'Cost',
      value: cost.text,
      detail: cost.note ?? COST_MODE_DETAILS[view.costMode],
    });
  }

  figures.push(
    {
      id: 'events',
      label: 'Events',
      value: formatCompact(totals.eventCount),
      detail: `${formatCount(totals.eventCount)} requests`,
    },
    {
      id: 'active',
      label: 'Active time',
      value: formatDuration(totals.activeMs),
      detail: '5-minute gaps at most',
    },
    {
      id: 'cache-hit',
      label: 'Cache hit rate',
      value: formatPercent(getCacheHitRate(totals)),
      detail: 'Cache reads of all prompt tokens',
    },
  );

  if (view.costMode !== null) {
    const hourlyCells = selectHourlyCells(report, cells);
    const hourly = sumCells(report, hourlyCells);
    const cost = getCost(report, hourly.costs, view.costMode);
    const perHour =
      cost.kind === 'value' ? getCostPerActiveHour(cost.costUsd, hourly.activeMs) : null;
    const { hourlyFrom } = report.data.meta;
    const clipped = hourlyCells.length < cells.length && hourlyFrom !== null;

    figures.push({
      id: 'cost-per-hour',
      label: 'Cost per active hour',
      value: formatUsdOrNone(perHour),
      detail: clipped
        ? `Approximate; hourly detail from ${formatDay(hourlyFrom)}`
        : 'Approximate; can differ from trends',
    });
  }

  return figures;
}

/** The panels that apply to the file, in list order: the leads above the controls. */
export function getPanelsFor<Panel extends { appliesTo: (report: ShareReport) => boolean }>(
  report: ShareReport,
  panels: readonly Panel[],
): Panel[] {
  return panels.filter((panel) => panel.appliesTo(report));
}

export type EmptyState = {
  title: string;
  body: string;
  /** The way out the page offers. */
  action?: 'reset-filters' | 'reset-view';
};

/** Why the view shows nothing, or undefined when it has data. */
export function getEmptyState(context: ShareViewContext): EmptyState | undefined {
  const { report, view, cells } = context;

  if (report.cellCount === 0) {
    const { since, until } = report.data.meta.window;
    return {
      title: 'No usage in this file',
      body: `The command found no usage for ${formatDateRange(since, resolveUntil(report, until)).replace(/^A/u, 'a')}. Run it again with a wider period to share one.`,
    };
  }

  if (cells.length > 0) {
    return undefined;
  }

  return hasLabelFilters(view)
    ? {
        title: 'Nothing matches these filters',
        body: `No usage in ${formatDateRange(view.since, resolveUntil(report, view.until))} matches the selected labels.`,
        action: 'reset-filters',
      }
    : {
        title: 'No usage in this period',
        body: `The file has no usage in ${formatDateRange(view.since, resolveUntil(report, view.until))}. Pick another period or go back to the opening view.`,
        action: 'reset-view',
      };
}
