import path from 'node:path';

import { markdownTable } from 'markdown-table';

import type { SessionDataResult } from '../cli/usage-data-contracts.js';
import type { SessionRepoRow, SessionRow } from '../session/session-row.js';
import { getPeriodKey } from '../utils/time-buckets.js';
import { formatDuration } from './format-duration.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { renderReportHeader } from './report-header.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';
import { renderReportJson } from './report-json.js';

export type SessionReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderSessionReportOptions = {
  timezone: string;
  useColor?: boolean;
  truncateSessionIds?: boolean;
};

const sessionTableHeaders = [
  'Session',
  'Source',
  'Repo',
  'Last Activity',
  'Duration',
  'Total',
  'Cost',
  'Models',
] as const;

const repoTableHeaders = ['Repo', 'Sessions', 'Last Activity', 'Total', 'Cost', 'Sources'] as const;

const MAX_NAMED_MODELS = 2;

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

function formatCost(row: { costUsd?: number; costIncomplete?: boolean }): string {
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

  if (models.length <= MAX_NAMED_MODELS) {
    return models.join('\n');
  }

  return [...models.slice(0, MAX_NAMED_MODELS), `+${models.length - MAX_NAMED_MODELS} more`].join(
    '\n',
  );
}

function toSessionTableCells(
  row: SessionRow,
  options: { timezone: string; truncateSessionIds: boolean },
): string[] {
  return [
    options.truncateSessionIds ? truncateSessionId(row.sessionId) : row.sessionId,
    row.source,
    row.repoRoot ? path.basename(row.repoRoot) : '-',
    getPeriodKey(row.lastActivity, 'daily', options.timezone),
    formatDuration(row.durationMs),
    formatInteger(row.totalTokens),
    formatCost(row),
    formatModels(row.models),
  ];
}

function toRepoTableCells(row: SessionRepoRow, timezone: string): string[] {
  return [
    row.repoRoot ? path.basename(row.repoRoot) : '(no repo)',
    formatInteger(row.sessionCount),
    getPeriodKey(row.lastActivity, 'daily', timezone),
    formatInteger(row.totalTokens),
    formatCost(row),
    row.sources.join(', '),
  ];
}

type SessionTableCells = {
  headers: string[];
  bodyRows: string[][];
  markdownAlign: ('l' | 'r')[];
};

function buildTableCells(
  sessionData: SessionDataResult,
  options: RenderSessionReportOptions,
): SessionTableCells {
  if (sessionData.grouping === 'repo') {
    return {
      headers: [...repoTableHeaders],
      bodyRows: sessionData.rows.map((row) => toRepoTableCells(row, options.timezone)),
      markdownAlign: ['l', 'r', 'l', 'r', 'r', 'l'],
    };
  }

  return {
    headers: [...sessionTableHeaders],
    bodyRows: sessionData.rows.map((row) =>
      toSessionTableCells(row, {
        timezone: options.timezone,
        truncateSessionIds: options.truncateSessionIds ?? true,
      }),
    ),
    markdownAlign: ['l', 'l', 'l', 'l', 'r', 'r', 'r', 'l'],
  };
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
  const { headers, bodyRows } = buildTableCells(sessionData, options);
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
      headerCells: headers,
      bodyRows,
      measureHeaderCells: headers,
      measureBodyRows: bodyRows,
      rowMetas: bodyRows.map(() => toRowMeta()),
      layout: 'top_aligned',
      multilineColumnIndex: headers.length - 1,
      multilineColumnWidth: 32,
    }),
  );

  return outputLines.join('\n');
}

function renderMarkdownSessionReport(
  sessionData: SessionDataResult,
  options: RenderSessionReportOptions,
): string {
  const { headers, bodyRows, markdownAlign } = buildTableCells(sessionData, options);
  const safeBodyRows = bodyRows.map((row) => row.map((cell) => toMarkdownSafeCell(cell)));

  return markdownTable([headers, ...safeBodyRows], {
    align: markdownAlign,
  });
}

export function renderSessionReport(
  sessionData: SessionDataResult,
  format: SessionReportFormat,
  options: RenderSessionReportOptions,
): string {
  switch (format) {
    case 'json':
      return renderReportJson('session', sessionData.rows);
    case 'markdown':
      return renderMarkdownSessionReport(sessionData, options);
    case 'terminal':
      return renderTerminalSessionReport(sessionData, options);
  }
}
