import { markdownTable } from 'markdown-table';

import type { SummaryDataResult, SummaryPeriod } from '../cli/usage-data-contracts.js';
import { renderActivityHeatmap } from './activity-heatmap.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import { formatApproxUsd, formatCompact, formatInteger, formatUsd } from './share-svg-theme.js';
import { resolveTtyColumns } from './table-text-layout.js';
import {
  defaultTerminalStylePalette,
  type TerminalStylePalette,
  type TextStyler,
} from './terminal-style-policy.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';

export type SummaryReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderSummaryReportOptions = {
  useColor?: boolean;
  palette?: TerminalStylePalette;
  /** Overrides the TTY width the activity heatmap is fitted to. */
  terminalWidth?: number;
};

const summaryTableHeaders = ['Period', 'Cost', 'Tokens', 'Top source'] as const;

const integerFormatter = new Intl.NumberFormat('en-US');
const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatCost(period: SummaryPeriod): string {
  if (period.totals.costUsd === undefined) {
    return '-';
  }

  // A `~` marks totals that leave out events whose model has no known price.
  return `${period.totals.costIncomplete ? '~' : ''}${usdFormatter.format(period.totals.costUsd)}`;
}

function formatTopSource(period: SummaryPeriod): string {
  if (period.sources.length === 0) {
    return '-';
  }

  const topSource = period.sources[0];

  const totalCost = period.totals.costUsd ?? 0;

  if (totalCost <= 0 || topSource.costUsd === undefined) {
    return topSource.source;
  }

  // Like the Cost column, a `~` marks a share computed from incomplete costs.
  const share = `${String(Math.round((topSource.costUsd / totalCost) * 100))}%`;
  return `${topSource.source} (${period.totals.costIncomplete ? '~' : ''}${share})`;
}

function toTableRow(period: SummaryPeriod): string[] {
  return [
    period.label,
    formatCost(period),
    integerFormatter.format(period.totals.totalTokens),
    formatTopSource(period),
  ];
}

function hasAnyUsage(summaryData: SummaryDataResult): boolean {
  return summaryData.periods.some((period) => period.totals.events > 0);
}

function getTitle(summaryData: SummaryDataResult): string {
  const today = summaryData.periods[0]?.until ?? '';
  return `Usage summary for ${today} (${summaryData.timezone})`;
}

function formatDays(count: number): string {
  return `${formatInteger(count)} day${count === 1 ? '' : 's'}`;
}

function formatBestDay(activity: SummaryDataResult['activity']): string {
  const bestDay = activity.bestDay;

  if (bestDay === undefined) {
    return '-';
  }

  const cost =
    bestDay.costUsd === undefined
      ? ''
      : ` · ${formatApproxUsd(bestDay.costUsd, bestDay.costIncomplete)}`;
  return `${bestDay.date}${cost} · ${formatCompact(bestDay.totalTokens)} tokens`;
}

function toActivityStats(activity: SummaryDataResult['activity']): [string, string][] {
  return [
    ['Current streak', formatDays(activity.currentStreak)],
    ['Longest streak', formatDays(activity.longestStreak)],
    ['Best day', formatBestDay(activity)],
    ['Active days', formatInteger(activity.activeDays)],
  ];
}

function renderTerminalActivity(
  activity: SummaryDataResult['activity'],
  options: RenderSummaryReportOptions,
  useColor: boolean,
): string[] {
  const palette = options.palette ?? defaultTerminalStylePalette;
  const paint =
    (styler: TextStyler): TextStyler =>
    (text) =>
      useColor ? styler(text) : text;
  const dim = paint(palette.dim);
  const stats = toActivityStats(activity);
  const labelWidth = Math.max(...stats.map(([label]) => label.length));
  const valueStylers = [
    paint((text) => palette.bold(palette.yellow(text))),
    paint(palette.yellow),
    paint(palette.white),
    paint(palette.white),
  ];
  const heatmap = renderActivityHeatmap(
    activity.days,
    {
      dim,
      level: (level) =>
        level === 0
          ? dim
          : level >= 3
            ? paint((text) => palette.bold(palette.green(text)))
            : paint(palette.green),
    },
    options.terminalWidth ?? resolveTtyColumns(process.stdout),
  );

  return [
    '',
    `Activity ${dim(`since ${activity.from}`)}`,
    ...stats.map(
      ([label, value], index) => `${dim(label.padEnd(labelWidth))}  ${valueStylers[index](value)}`,
    ),
    ...(heatmap.length > 0 ? ['', ...heatmap] : []),
  ];
}

type MonthNote = { text: string; warning: boolean };

/** Month-end projection, budget status, and cache savings, in that order. */
function toMonthNotes(summaryData: SummaryDataResult): MonthNote[] {
  const { monthEnd } = summaryData;
  const monthToDate = summaryData.periods.find((period) => period.key === 'monthToDate');
  const spentUsd = monthToDate?.totals.costUsd;
  const spent = formatApproxUsd(spentUsd, monthToDate?.totals.costIncomplete);
  const notes: MonthNote[] = [];

  if (monthEnd.projectedCostUsd !== undefined) {
    notes.push({
      text: `On pace for ${formatApproxUsd(monthEnd.projectedCostUsd, monthEnd.costIncomplete)} this month`,
      warning: false,
    });
  }

  if (monthEnd.budgetUsd !== undefined) {
    const budget = formatUsd(monthEnd.budgetUsd);

    if ((spentUsd ?? 0) > monthEnd.budgetUsd) {
      notes.push({ text: `Over your ${budget} monthly budget: ${spent} spent`, warning: true });
    } else if ((monthEnd.projectedCostUsd ?? 0) > monthEnd.budgetUsd) {
      const overBy = formatApproxUsd(
        (monthEnd.projectedCostUsd ?? 0) - monthEnd.budgetUsd,
        monthEnd.costIncomplete,
      );
      notes.push({
        text: `On pace to exceed your ${budget} monthly budget by ${overBy}`,
        warning: true,
      });
    } else {
      notes.push({ text: `Within your ${budget} monthly budget (${spent} spent)`, warning: false });
    }
  }

  if (summaryData.monthToDateCacheSavingsUsd !== undefined) {
    // The savings are an estimate, so they always carry the approximate marker.
    notes.push({
      text: `Prompt caching saved you ${formatApproxUsd(summaryData.monthToDateCacheSavingsUsd, true)} this month`,
      warning: false,
    });
  }

  return notes;
}

function renderTerminalSummaryReport(
  summaryData: SummaryDataResult,
  options: RenderSummaryReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const bodyRows = summaryData.periods.map(toTableRow);
  const rowMetas: TableRowMeta[] = bodyRows.map(() => ({
    periodKey: 'summary',
    rowKind: 'detail',
  }));
  const lines = [renderReportHeader({ title: getTitle(summaryData), useColor }), ''];

  if (!hasAnyUsage(summaryData)) {
    lines.push(
      'No usage found in the last 7 days or this month. Run `llm-usage doctor` to see which sources were found.',
    );
    lines.push('');
  }

  lines.push(
    renderUnicodeTable({
      headerCells: summaryTableHeaders,
      bodyRows,
      measureHeaderCells: summaryTableHeaders,
      measureBodyRows: bodyRows,
      rowMetas,
      layout: 'compact',
      multilineColumnIndex: 0,
      multilineColumnWidth: 13,
      leftAlignedColumnIndexes: [3],
    }),
  );

  const monthNotes = toMonthNotes(summaryData);

  if (monthNotes.length > 0) {
    const palette = options.palette ?? defaultTerminalStylePalette;
    const warn = (text: string) => (useColor ? palette.yellow(text) : text);
    lines.push(
      '',
      ...monthNotes.map((note) => (note.warning ? warn(`⚠ ${note.text}`) : note.text)),
    );
  }

  if (summaryData.activity.activeDays > 0) {
    lines.push(...renderTerminalActivity(summaryData.activity, options, useColor));
  }

  return lines.join('\n');
}

function renderMarkdownSummaryReport(summaryData: SummaryDataResult): string {
  const rows = [
    ['Period', 'Dates', 'Cost', 'Tokens', 'Top source'],
    ...summaryData.periods.map((period) => {
      const [label, ...values] = toTableRow(period);
      const dates =
        period.since === period.until ? period.since : `${period.since} to ${period.until}`;
      return [label, dates, ...values];
    }),
  ];

  return [
    // The title is a date and a validated timezone, so it needs no escaping.
    `### ${getTitle(summaryData)}`,
    '',
    markdownTable(
      rows.map((row) => row.map((cell) => toMarkdownSafeCell(cell))),
      { align: ['l', 'l', 'r', 'r', 'l'] },
    ),
    ...toMonthNotes(summaryData).flatMap((note) => [
      '',
      toMarkdownSafeCell(note.warning ? `⚠ ${note.text}` : note.text),
    ]),
    '',
    `#### Activity since ${summaryData.activity.from}`,
    '',
    markdownTable(
      [['Stat', 'Value'], ...toActivityStats(summaryData.activity)].map((row) =>
        row.map((cell) => toMarkdownSafeCell(cell)),
      ),
      { align: ['l', 'r'] },
    ),
  ].join('\n');
}

export function renderSummaryReport(
  summaryData: SummaryDataResult,
  format: SummaryReportFormat,
  options: RenderSummaryReportOptions = {},
): string {
  switch (format) {
    case 'json':
      return renderReportJson('summary', {
        timezone: summaryData.timezone,
        periods: summaryData.periods,
        monthEnd: summaryData.monthEnd,
        monthToDateCacheSavingsUsd: summaryData.monthToDateCacheSavingsUsd,
        activity: summaryData.activity,
      });
    case 'markdown':
      return renderMarkdownSummaryReport(summaryData);
    case 'terminal':
      return renderTerminalSummaryReport(summaryData, options);
  }
}
