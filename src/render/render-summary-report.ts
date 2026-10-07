import { markdownTable } from 'markdown-table';

import type { SummaryDataResult, SummaryPeriod } from '../cli/usage-data-contracts.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';

export type SummaryReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderSummaryReportOptions = {
  useColor?: boolean;
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
      });
    case 'markdown':
      return renderMarkdownSummaryReport(summaryData);
    case 'terminal':
      return renderTerminalSummaryReport(summaryData, options);
  }
}
