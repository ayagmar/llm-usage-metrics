import { markdownTable } from 'markdown-table';
import pc from 'picocolors';

import type {
  CompareDataResult,
  CompareMetricRow,
  CompareSourceRow,
} from '../cli/usage-data-contracts.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { renderReportHeader } from './report-header.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';

export type CompareReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderCompareReportOptions = {
  useColor?: boolean;
};

const integerFormatter = new Intl.NumberFormat('en-US');
const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const percentFormatter = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const compareTableHeaders = ['Metric', 'Current', 'Baseline', 'Δ', 'Δ%'] as const;
const sourceTableHeaders = ['Source', 'Current', 'Baseline', 'Δ', 'Δ%'] as const;

function formatInteger(value: number | undefined, options: { signed?: boolean } = {}): string {
  if (value === undefined) {
    return '-';
  }

  if (!options.signed || value === 0) {
    return integerFormatter.format(value);
  }

  const sign = value > 0 ? '+' : '-';
  return `${sign}${integerFormatter.format(Math.abs(value))}`;
}

function formatUsd(
  value: number | undefined,
  options: { approximate?: boolean; signed?: boolean } = {},
): string {
  if (value === undefined) {
    return '-';
  }

  const sign = options.signed && value !== 0 ? (value > 0 ? '+' : '-') : '';
  const formatted = usdFormatter.format(Math.abs(value));
  return `${options.approximate ? '~' : ''}${sign}${formatted}`;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) {
    return '-';
  }

  if (value === 0) {
    return '0%';
  }

  const sign = value > 0 ? '+' : '';
  return `${sign}${percentFormatter.format(value)}`;
}

function colorizeDelta(value: string, numericValue: number | undefined, useColor: boolean): string {
  if (!useColor || numericValue === undefined || numericValue === 0) {
    return value;
  }

  return numericValue > 0 ? pc.green(value) : pc.red(value);
}

function formatMetricValue(
  row: CompareMetricRow,
  value: number | undefined,
  approximate: boolean | undefined,
): string {
  if (row.valueType === 'usd') {
    return formatUsd(value, { approximate });
  }

  return formatInteger(value);
}

function formatMetricDelta(row: CompareMetricRow): string {
  if (row.valueType === 'usd') {
    return formatUsd(row.delta, {
      approximate: row.deltaCostIncomplete,
      signed: true,
    });
  }

  return formatInteger(row.delta, { signed: true });
}

function toMetricTableRow(row: CompareMetricRow, useColor: boolean): string[] {
  const delta = formatMetricDelta(row);
  const deltaPercent = formatPercent(row.deltaPercent);

  return [
    row.label,
    formatMetricValue(row, row.current, row.currentCostIncomplete),
    formatMetricValue(row, row.baseline, row.baselineCostIncomplete),
    colorizeDelta(delta, row.delta, useColor),
    colorizeDelta(deltaPercent, row.deltaPercent, useColor),
  ];
}

function toSourceTableRow(row: CompareSourceRow, useColor: boolean): string[] {
  const delta = formatUsd(row.delta.costUsd, {
    approximate: row.delta.costIncomplete,
    signed: true,
  });
  const deltaPercent = formatPercent(row.deltaPercent.costUsd);

  return [
    row.source,
    formatUsd(row.current.costUsd, { approximate: row.current.costIncomplete }),
    formatUsd(row.baseline.costUsd, { approximate: row.baseline.costIncomplete }),
    colorizeDelta(delta, row.delta.costUsd, useColor),
    colorizeDelta(deltaPercent, row.deltaPercent.costUsd, useColor),
  ];
}

function createRowMetas(rowCount: number): TableRowMeta[] {
  return Array.from({ length: rowCount }, () => ({
    periodKey: 'compare',
    rowKind: 'detail' as const,
  }));
}

function renderTerminalTable(options: {
  headerCells: readonly string[];
  bodyRows: string[][];
  firstColumnWidth: number;
}): string {
  return renderUnicodeTable({
    headerCells: options.headerCells,
    bodyRows: options.bodyRows,
    measureHeaderCells: options.headerCells,
    measureBodyRows: options.bodyRows,
    rowMetas: createRowMetas(options.bodyRows.length),
    layout: 'compact',
    multilineColumnIndex: 0,
    multilineColumnWidth: options.firstColumnWidth,
  });
}

function renderTerminalCompareReport(
  compareData: CompareDataResult,
  options: RenderCompareReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const lines: string[] = [];

  lines.push(
    renderReportHeader({
      title: `Compare: ${compareData.current.window.label} vs ${compareData.baseline.window.label}`,
      useColor,
    }),
  );
  lines.push('');

  if (compareData.current.totals.events === 0 && compareData.baseline.totals.events === 0) {
    lines.push('No usage data found for the selected filters.');
    lines.push('');
  }

  lines.push(
    renderTerminalTable({
      headerCells: compareTableHeaders,
      bodyRows: compareData.totals.map((row) => toMetricTableRow(row, useColor)),
      firstColumnWidth: 14,
    }),
  );
  lines.push('');
  lines.push('By source (cost)');
  lines.push(
    renderTerminalTable({
      headerCells: sourceTableHeaders,
      bodyRows: compareData.sources.map((row) => toSourceTableRow(row, useColor)),
      firstColumnWidth: 14,
    }),
  );

  return lines.join('\n');
}

function renderMarkdownRows(headers: readonly string[], rows: string[][]): string {
  return markdownTable(
    [[...headers], ...rows].map((row) => row.map((cell) => toMarkdownSafeCell(cell))),
    { align: ['l', 'r', 'r', 'r', 'r'] },
  );
}

function renderMarkdownCompareReport(compareData: CompareDataResult): string {
  return [
    `### Compare: ${toMarkdownSafeCell(compareData.current.window.label)} vs ${toMarkdownSafeCell(
      compareData.baseline.window.label,
    )}`,
    '',
    renderMarkdownRows(
      compareTableHeaders,
      compareData.totals.map((row) => toMetricTableRow(row, false)),
    ),
    '',
    '### By source (cost)',
    '',
    renderMarkdownRows(
      sourceTableHeaders,
      compareData.sources.map((row) => toSourceTableRow(row, false)),
    ),
  ].join('\n');
}

export function renderCompareReport(
  compareData: CompareDataResult,
  format: CompareReportFormat,
  options: RenderCompareReportOptions = {},
): string {
  switch (format) {
    case 'json':
      return JSON.stringify(compareData, null, 2);
    case 'markdown':
      return renderMarkdownCompareReport(compareData);
    case 'terminal':
      return renderTerminalCompareReport(compareData, options);
  }
}
