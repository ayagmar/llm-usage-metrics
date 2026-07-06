import { markdownTable } from 'markdown-table';

import type { SessionDataResult } from '../cli/usage-data-contracts.js';
import type { SessionRow } from '../session/session-row.js';
import { getPeriodKey } from '../utils/time-buckets.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { renderReportHeader } from './report-header.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';

export type SessionReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderSessionReportOptions = {
  timezone: string;
  useColor?: boolean;
};

const sessionTableHeaders = [
  'Session',
  'Source',
  'Last Activity',
  'Events',
  'Input',
  'Output',
  'Cache R/W',
  'Total',
  'Cost',
  'Models',
] as const;

const integerFormatter = new Intl.NumberFormat('en-US');

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function truncateSessionId(sessionId: string): string {
  if (sessionId.length <= 12) {
    return sessionId;
  }

  return `…${sessionId.slice(-12)}`;
}

function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

function formatCost(row: SessionRow): string {
  if (row.costUsd === undefined) {
    return '-';
  }

  const formatted = usdFormatter.format(row.costUsd);
  return row.costIncomplete ? `~${formatted}` : formatted;
}

function formatModels(models: readonly string[]): string {
  if (models.length === 0) {
    return '-';
  }

  return models.join('\n');
}

function toTableCells(row: SessionRow, timezone: string): string[] {
  return [
    truncateSessionId(row.sessionId),
    row.source,
    getPeriodKey(row.lastActivity, 'daily', timezone),
    formatInteger(row.eventCount),
    formatInteger(row.inputTokens),
    formatInteger(row.outputTokens),
    `${formatInteger(row.cacheReadTokens)} / ${formatInteger(row.cacheWriteTokens)}`,
    formatInteger(row.totalTokens),
    formatCost(row),
    formatModels(row.models),
  ];
}

function toRowMeta(): TableRowMeta {
  return {
    periodKey: '',
    rowKind: 'detail',
  };
}

function renderTerminalSessionReport(
  sessionData: SessionDataResult,
  options: RenderSessionReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const bodyRows = sessionData.rows.map((row) => toTableCells(row, options.timezone));
  const outputLines = [
    renderReportHeader({
      title: 'Session Usage Report',
      useColor,
    }),
    '',
  ];

  if (bodyRows.length === 0) {
    outputLines.push('No usage data found for the selected filters.');
    return outputLines.join('\n');
  }

  outputLines.push(
    renderUnicodeTable({
      headerCells: [...sessionTableHeaders],
      bodyRows,
      measureHeaderCells: [...sessionTableHeaders],
      measureBodyRows: bodyRows,
      rowMetas: bodyRows.map(() => toRowMeta()),
      layout: 'top_aligned',
      multilineColumnIndex: sessionTableHeaders.length - 1,
      multilineColumnWidth: 32,
    }),
  );

  return outputLines.join('\n');
}

function renderMarkdownSessionReport(
  sessionData: SessionDataResult,
  options: RenderSessionReportOptions,
): string {
  const bodyRows = sessionData.rows
    .map((row) => toTableCells(row, options.timezone))
    .map((row) => row.map((cell) => toMarkdownSafeCell(cell)));
  const tableRows = [[...sessionTableHeaders], ...bodyRows];

  return markdownTable(tableRows, {
    align: ['l', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'l'],
  });
}

export function renderSessionReport(
  sessionData: SessionDataResult,
  format: SessionReportFormat,
  options: RenderSessionReportOptions,
): string {
  switch (format) {
    case 'json':
      return JSON.stringify(sessionData.rows, null, 2);
    case 'markdown':
      return renderMarkdownSessionReport(sessionData, options);
    case 'terminal':
      return renderTerminalSessionReport(sessionData, options);
  }
}
