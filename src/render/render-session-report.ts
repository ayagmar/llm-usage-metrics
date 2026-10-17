import { markdownTable } from 'markdown-table';

import { toProjectKey, UNATTRIBUTED_PROJECT_LABEL } from '../aggregate/project-key.js';
import type { SessionDataResult } from '../cli/usage-data-contracts.js';
import type { SessionRepoRow, SessionRow } from '../session/session-row.js';
import { getPeriodKey } from '../utils/time-buckets.js';
import { formatDuration } from './format-duration.js';
import { formatApproxUsd, formatInteger } from './format-number.js';
import { truncateNames } from './truncate-names.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { columnKindsFromAlign, renderUnicodeTable, type TableRowMeta } from './unicode-table.js';
import { renderReportJson } from './report-json.js';
import {
  renderMarkdownSessionTimeline,
  renderTerminalSessionTimeline,
} from './render-session-timeline.js';
import { resolveTtyColumns, wrapTableColumn } from './table-text-layout.js';

export type SessionReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderSessionReportOptions = {
  timezone: string;
  useColor?: boolean;
  truncateSessionIds?: boolean;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
};

export const MODELS_COLUMN_WIDTH = 32;

const sessionTableHeaders = [
  'Session',
  'Source',
  'Project',
  'Last Activity',
  'Duration',
  'Total',
  'Cost',
  'Models',
] as const;

const repoTableHeaders = [
  'Project',
  'Sessions',
  'Last Activity',
  'Total',
  'Cost',
  'Sources',
] as const;

const MAX_NAMED_MODELS = 2;

export function truncateSessionId(sessionId: string): string {
  if (sessionId.length <= 12) {
    return sessionId;
  }

  return `…${sessionId.slice(-12)}`;
}

function formatCost(row: { costUsd?: number; costIncomplete?: boolean }): string {
  return formatApproxUsd(row.costUsd, row.costIncomplete);
}

export function formatModels(models: readonly string[]): string {
  if (models.length === 0) {
    return '-';
  }

  return truncateNames(models, MAX_NAMED_MODELS).join('\n');
}

type ProjectLabels = ReadonlyMap<string | undefined, string>;

export function toProjectLabel(repoRoot: string | undefined, projectLabels: ProjectLabels): string {
  return projectLabels.get(toProjectKey(repoRoot)) ?? UNATTRIBUTED_PROJECT_LABEL;
}

function toSessionTableCells(
  row: SessionRow,
  options: { timezone: string; truncateSessionIds: boolean; projectLabels: ProjectLabels },
): string[] {
  return [
    options.truncateSessionIds ? truncateSessionId(row.sessionId) : row.sessionId,
    row.source,
    toProjectLabel(row.repoRoot, options.projectLabels),
    getPeriodKey(row.lastActivity, 'daily', options.timezone),
    formatDuration(row.durationMs),
    formatInteger(row.totalTokens),
    formatCost(row),
    formatModels(row.models),
  ];
}

function toRepoTableCells(
  row: SessionRepoRow,
  timezone: string,
  projectLabels: ProjectLabels,
): string[] {
  return [
    toProjectLabel(row.repoRoot, projectLabels),
    formatInteger(row.sessionCount),
    getPeriodKey(row.lastActivity, 'daily', timezone),
    formatInteger(row.totalTokens),
    formatCost(row),
    row.sources.join(', '),
  ];
}

/** The session and repo lists; `--timeline` renders on its own. */
type SessionListData = Exclude<SessionDataResult, { grouping: 'timeline' }>;

type SessionTableCells = {
  headers: string[];
  bodyRows: string[][];
  align: ('l' | 'r')[];
};

function buildTableCells(
  sessionData: SessionListData,
  options: RenderSessionReportOptions,
): SessionTableCells {
  const { projectLabels } = sessionData;

  if (sessionData.grouping === 'repo') {
    return {
      headers: [...repoTableHeaders],
      bodyRows: sessionData.rows.map((row) =>
        toRepoTableCells(row, options.timezone, projectLabels),
      ),
      align: ['l', 'r', 'l', 'r', 'r', 'l'],
    };
  }

  return {
    headers: [...sessionTableHeaders],
    bodyRows: sessionData.rows.map((row) =>
      toSessionTableCells(row, {
        timezone: options.timezone,
        truncateSessionIds: options.truncateSessionIds ?? true,
        projectLabels,
      }),
    ),
    align: ['l', 'l', 'l', 'l', 'r', 'r', 'r', 'l'],
  };
}

function toRowMeta(): TableRowMeta {
  return {
    periodKey: '',
    rowKind: 'detail',
  };
}

function renderTerminalSessionReport(
  sessionData: SessionListData,
  options: RenderSessionReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const { headers, bodyRows, align } = buildTableCells(sessionData, options);
  const outputLines = [
    renderReportHeader({
      title: 'Session Usage Report',
      useColor,
    }),
    '',
  ];

  if (bodyRows.length === 0) {
    outputLines.push(formatNoUsageMessage(options.filtered ?? false));
    return outputLines.join('\n');
  }

  const modelsColumnIndex = headers.length - 1;
  const wrappedRows = wrapTableColumn(bodyRows, {
    columnIndex: modelsColumnIndex,
    width: MODELS_COLUMN_WIDTH,
  });

  outputLines.push(
    renderUnicodeTable({
      headerCells: headers,
      bodyRows: wrappedRows,
      measureHeaderCells: headers,
      measureBodyRows: wrappedRows,
      rowMetas: wrappedRows.map(() => toRowMeta()),
      layout: 'top_aligned',
      columnKinds: columnKindsFromAlign(align),
      multilineColumnIndex: modelsColumnIndex,
      multilineColumnWidth: MODELS_COLUMN_WIDTH,
      terminalWidth: resolveTtyColumns(process.stdout),
      stackedTitleColumnCount: 1,
    }),
  );

  return outputLines.join('\n');
}

function renderMarkdownSessionReport(
  sessionData: SessionListData,
  options: RenderSessionReportOptions,
): string {
  const { headers, bodyRows, align } = buildTableCells(sessionData, options);
  const safeBodyRows = bodyRows.map((row) => row.map((cell) => toMarkdownSafeCell(cell)));

  return markdownTable([headers, ...safeBodyRows], {
    align,
  });
}

function renderSessionTimelineReport(
  sessionData: Extract<SessionDataResult, { grouping: 'timeline' }>,
  format: SessionReportFormat,
  options: RenderSessionReportOptions,
): string {
  const { session, rows } = sessionData;

  switch (format) {
    case 'json':
      return renderReportJson('session', { session, rows });
    case 'markdown':
      return renderMarkdownSessionTimeline(session, rows, options.timezone);
    case 'terminal':
      return renderTerminalSessionTimeline(session, rows, {
        timezone: options.timezone,
        useColor: options.useColor ?? shouldUseColorByDefault(),
        projectLabel: toProjectLabel(session.repoRoot, sessionData.projectLabels),
      });
  }
}

export function renderSessionReport(
  sessionData: SessionDataResult,
  format: SessionReportFormat,
  options: RenderSessionReportOptions,
): string {
  if (sessionData.grouping === 'timeline') {
    return renderSessionTimelineReport(sessionData, format, options);
  }

  switch (format) {
    case 'json':
      return renderReportJson('session', sessionData.rows);
    case 'markdown':
      return renderMarkdownSessionReport(sessionData, options);
    case 'terminal':
      return renderTerminalSessionReport(sessionData, options);
  }
}
