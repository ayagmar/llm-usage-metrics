import { markdownTable } from 'markdown-table';

import { toProjectLabel } from '../aggregate/project-key.js';
import type { SessionDataResult } from '../cli/usage-data-contracts.js';
import type { SessionRepoRow, SessionRow } from '../session/session-row.js';
import { getPeriodKey } from '../utils/time-buckets.js';
import { formatDuration } from './format-duration.js';
import { formatAbbreviatedTokenCount, formatApproxUsd, formatInteger } from './format-number.js';
import { truncateNames } from './truncate-names.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { createColorRoles, type ColorRoles, type TextStyler } from './terminal-style-policy.js';
import {
  columnKindsFromAlign,
  renderUnicodeTableWithFit,
  type TableRowMeta,
} from './unicode-table.js';
import { renderReportJson } from './report-json.js';
import {
  renderMarkdownSessionTimeline,
  renderTerminalSessionTimeline,
} from './render-session-timeline.js';
import { describeTableFit } from './table-fit-note.js';
import {
  resolveTtyColumns,
  splitCellLines,
  wrapProse,
  wrapTableColumn,
} from './table-text-layout.js';

export type SessionReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderSessionReportOptions = {
  timezone: string;
  useColor?: boolean;
  truncateSessionIds?: boolean;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
};

export type RenderedSessionReport = {
  output: string;
  /** stderr notes about what a narrow terminal left out of the table. */
  notes: string[];
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

/**
 * The models cell wrapped to the Models column, one name per line: the first model in the
 * default color, the other models and `+N more` styled `secondary`.
 */
export function formatModelsCell(cell: string, width: number, secondary: TextStyler): string {
  return splitCellLines(cell)
    .map((name, index) =>
      splitCellLines(wrapProse(name, width))
        .map((line) => (index === 0 ? line : secondary(line)))
        .join('\n'),
    )
    .join('\n');
}

type ProjectLabels = ReadonlyMap<string | undefined, string>;

type FormatNumber = (value: number) => string;

function toSessionTableCells(
  row: SessionRow,
  options: {
    timezone: string;
    truncateSessionIds: boolean;
    projectLabels: ProjectLabels;
    formatTokens: FormatNumber;
  },
): string[] {
  return [
    options.truncateSessionIds ? truncateSessionId(row.sessionId) : row.sessionId,
    row.source,
    toProjectLabel(row.repoRoot, options.projectLabels),
    getPeriodKey(row.lastActivity, 'daily', options.timezone),
    formatDuration(row.durationMs),
    options.formatTokens(row.totalTokens),
    formatCost(row),
    formatModels(row.models),
  ];
}

function toRepoTableCells(
  row: SessionRepoRow,
  options: { timezone: string; projectLabels: ProjectLabels; formatTokens: FormatNumber },
): string[] {
  return [
    toProjectLabel(row.repoRoot, options.projectLabels),
    formatInteger(row.sessionCount),
    getPeriodKey(row.lastActivity, 'daily', options.timezone),
    options.formatTokens(row.totalTokens),
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
  /** Columns a narrow terminal hides, least useful first. */
  hideableColumns: number[];
};

function buildTableCells(
  sessionData: SessionListData,
  options: RenderSessionReportOptions,
  formatTokens: FormatNumber = formatInteger,
): SessionTableCells {
  const { projectLabels } = sessionData;
  const hideable = (headers: readonly string[], hidden: readonly string[]) =>
    hidden.map((header) => headers.indexOf(header));

  if (sessionData.grouping === 'repo') {
    return {
      headers: [...repoTableHeaders],
      bodyRows: sessionData.rows.map((row) =>
        toRepoTableCells(row, { timezone: options.timezone, projectLabels, formatTokens }),
      ),
      align: ['l', 'r', 'l', 'r', 'r', 'l'],
      hideableColumns: hideable(repoTableHeaders, ['Sources', 'Last Activity']),
    };
  }

  return {
    headers: [...sessionTableHeaders],
    bodyRows: sessionData.rows.map((row) =>
      toSessionTableCells(row, {
        timezone: options.timezone,
        truncateSessionIds: options.truncateSessionIds ?? true,
        projectLabels,
        formatTokens,
      }),
    ),
    align: ['l', 'l', 'l', 'l', 'r', 'r', 'r', 'l'],
    hideableColumns: hideable(sessionTableHeaders, [
      'Models',
      'Duration',
      'Last Activity',
      'Source',
    ]),
  };
}

function toRowMeta(): TableRowMeta {
  return {
    periodKey: '',
    rowKind: 'detail',
  };
}

/** Plain cells to measure, and the same cells in their role colors; both wrap the last column. */
function toTerminalRows(
  headers: readonly string[],
  rows: string[][],
  roles: ColorRoles,
): { bodyRows: string[][]; measureBodyRows: string[][] } {
  const wrapColumnIndex = headers.length - 1;
  const styleCell = (cell: string, columnIndex: number): string => {
    switch (headers[columnIndex]) {
      case 'Source':
        return roles.source(cell)(cell);
      case 'Cost':
        return roles.money(cell);
      case 'Models':
        return formatModelsCell(cell, MODELS_COLUMN_WIDTH, roles.dim);
      default:
        return columnIndex === wrapColumnIndex ? wrapProse(cell, MODELS_COLUMN_WIDTH) : cell;
    }
  };

  return {
    bodyRows: rows.map((row) => row.map(styleCell)),
    measureBodyRows: wrapTableColumn(rows, {
      columnIndex: wrapColumnIndex,
      width: MODELS_COLUMN_WIDTH,
    }),
  };
}

function renderTerminalSessionReport(
  sessionData: SessionListData,
  options: RenderSessionReportOptions,
): RenderedSessionReport {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const roles = createColorRoles(useColor);
  const terminalWidth = resolveTtyColumns(process.stdout);
  const { headers, bodyRows, align, hideableColumns } = buildTableCells(sessionData, options);
  const outputLines = [
    renderReportHeader({ title: 'Session Usage Report', useColor, terminalWidth }),
    '',
  ];

  if (bodyRows.length === 0) {
    outputLines.push(formatNoUsageMessage(options.filtered ?? false));
    return { output: outputLines.join('\n'), notes: [] };
  }

  const full = toTerminalRows(headers, bodyRows, roles);
  const abbreviated = toTerminalRows(
    headers,
    buildTableCells(sessionData, options, formatAbbreviatedTokenCount).bodyRows,
    roles,
  );
  const wrapColumnIndex = headers.length - 1;
  const { output, fit } = renderUnicodeTableWithFit({
    headerCells: headers.map((header) => roles.header(header)),
    bodyRows: full.bodyRows,
    measureHeaderCells: headers,
    measureBodyRows: full.measureBodyRows,
    rowMetas: bodyRows.map(() => toRowMeta()),
    columnKinds: columnKindsFromAlign(align),
    multilineColumnIndex: wrapColumnIndex,
    terminalWidth,
    fit: {
      abbreviatedBodyRows: abbreviated.bodyRows,
      abbreviatedMeasureBodyRows: abbreviated.measureBodyRows,
      hideableColumns,
    },
    stackedTitleColumnCount: 1,
  });
  const fitNote = describeTableFit(fit);

  outputLines.push(output);

  return { output: outputLines.join('\n'), notes: fitNote ? [fitNote] : [] };
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
): RenderedSessionReport {
  const { session, rows } = sessionData;

  switch (format) {
    case 'json':
      return { output: renderReportJson('session', { session, rows }), notes: [] };
    case 'markdown':
      return { output: renderMarkdownSessionTimeline(session, rows, options.timezone), notes: [] };
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
): RenderedSessionReport {
  if (sessionData.grouping === 'timeline') {
    return renderSessionTimelineReport(sessionData, format, options);
  }

  switch (format) {
    case 'json':
      return { output: renderReportJson('session', sessionData.rows), notes: [] };
    case 'markdown':
      return { output: renderMarkdownSessionReport(sessionData, options), notes: [] };
    case 'terminal':
      return renderTerminalSessionReport(sessionData, options);
  }
}
