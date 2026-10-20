import { markdownTable } from 'markdown-table';

import { toProjectLabel } from '../aggregate/project-key.js';
import type { ContextDataResult } from '../cli/build-context-data.js';
import {
  LONG_CONTEXT_PROMPT_TOKENS,
  NEAR_LIMIT_SHARE,
  type AggregatedContextSource,
  type ContextModelRow,
  type ContextPressure,
  type ContextSessionRow,
} from '../context/context-pressure.js';
import { UNKNOWN_MODEL_LABEL } from '../share-report/redact.js';
import { pluralize } from '@ayagmar/agent-sessions/internal';
import { formatAbbreviatedTokenCount, formatApproxUsd, formatInteger } from './format-number.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { renderReportJson } from './report-json.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import {
  formatModels,
  formatModelsCell,
  MODELS_COLUMN_WIDTH,
  truncateSessionId,
} from './render-session-report.js';
import { describeTableFit } from './table-fit-note.js';
import {
  measureCellWidth,
  resolveTtyColumns,
  splitCellLines,
  wrapProse,
  wrapTableColumn,
} from './table-text-layout.js';
import { createColorRoles, type ColorRoles } from './terminal-style-policy.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { columnKindsFromAlign, renderUnicodeTableWithFit } from './unicode-table.js';

export type ContextReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderedContextReport = {
  output: string;
  /** stderr notes about what a narrow terminal left out of the table. */
  notes: string[];
};

export type RenderContextReportOptions = {
  useColor?: boolean;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
};

const LONG_CONTEXT_HEADER = `>${String(LONG_CONTEXT_PROMPT_TOKENS / 1000)}k`;
const NEAR_LIMIT_HEADER = `>${String(NEAR_LIMIT_SHARE * 100)}% Limit`;

const pressureHeaders = ['Requests', 'Peak', LONG_CONTEXT_HEADER, 'Tier Extra'];

type ContextTable = {
  headers: string[];
  bodyRows: string[][];
  align: ('l' | 'r')[];
  /** The column whose text wraps. */
  wrapColumnIndex: number;
  /** Leading columns that name a row when a narrow terminal lists rows. */
  titleColumnCount: number;
  /** Columns a narrow terminal hides first, least useful first. */
  hideableColumns: number[];
};

type FormatNumber = (value: number) => string;

function toPressureCells(row: ContextPressure, formatTokens: FormatNumber): string[] {
  return [
    formatInteger(row.requests),
    formatTokens(row.peakPromptTokens),
    formatInteger(row.longContextRequests),
    formatApproxUsd(row.longContextExtraUsd, row.longContextExtraIncomplete),
  ];
}

// An unknown limit shows `-`, like other unknown values, so it never reads as zero.
function formatOptional(value: number | undefined, format: FormatNumber = formatInteger): string {
  return value === undefined ? '-' : format(value);
}

function buildModelTable(
  rows: readonly ContextModelRow[],
  formatTokens: FormatNumber,
): ContextTable {
  const headers = ['Model', ...pressureHeaders, 'Limit', NEAR_LIMIT_HEADER];

  return {
    headers,
    bodyRows: rows.map((row) => [
      row.model ?? UNKNOWN_MODEL_LABEL,
      ...toPressureCells(row, formatTokens),
      formatOptional(row.contextLimit, formatTokens),
      formatOptional(row.nearLimitRequests),
    ]),
    align: ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
    wrapColumnIndex: 0,
    titleColumnCount: 1,
    hideableColumns: ['Tier Extra', 'Limit'].map((header) => headers.indexOf(header)),
  };
}

function buildSessionTable(
  rows: readonly ContextSessionRow[],
  projectLabels: ContextDataResult['projectLabels'],
  formatTokens: FormatNumber,
): ContextTable {
  const headers = ['Session', 'Source', 'Project', ...pressureHeaders, NEAR_LIMIT_HEADER, 'Models'];

  return {
    headers,
    bodyRows: rows.map((row) => [
      truncateSessionId(row.sessionId),
      row.source,
      toProjectLabel(row.repoRoot, projectLabels),
      ...toPressureCells(row, formatTokens),
      formatOptional(row.nearLimitRequests),
      formatModels(row.models),
    ]),
    align: ['l', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'l'],
    wrapColumnIndex: 8,
    titleColumnCount: 1,
    hideableColumns: ['Models', 'Tier Extra', 'Project'].map((header) => headers.indexOf(header)),
  };
}

function buildTable(
  data: ContextDataResult,
  formatTokens: FormatNumber = formatInteger,
): ContextTable {
  return data.grouping === 'session'
    ? buildSessionTable(data.sessions, data.projectLabels, formatTokens)
    : buildModelTable(data.models, formatTokens);
}

function formatAggregatedSourcesLine(
  sources: readonly AggregatedContextSource[],
): string | undefined {
  if (sources.length === 0) {
    return undefined;
  }

  const listed = sources
    .map(({ source, records }) => `${source} (${pluralize(records, 'record')})`)
    .join(', ');

  return `Aggregated, not per request: ${listed}. Their records sum several requests, so they have no peak or tier counts.`;
}

/** The cells in their role colors, wrapped like the table wraps them. */
function styleContextRows(table: ContextTable, rows: string[][], roles: ColorRoles): string[][] {
  return rows.map((row) =>
    row.map((cell, columnIndex) => {
      switch (table.headers[columnIndex]) {
        case 'Source':
          return roles.source(cell)(cell);
        case 'Tier Extra':
          return roles.money(cell);
        case 'Models':
          return formatModelsCell(cell, MODELS_COLUMN_WIDTH, roles.dim);
        default:
          return columnIndex === table.wrapColumnIndex
            ? wrapProse(cell, MODELS_COLUMN_WIDTH)
            : cell;
      }
    }),
  );
}

function renderTerminalContextReport(
  data: ContextDataResult,
  options: RenderContextReportOptions,
): RenderedContextReport {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const roles = createColorRoles(useColor);
  const terminalWidth = resolveTtyColumns(process.stdout);
  const lines = [
    renderReportHeader({ title: 'Context Pressure Report', useColor, terminalWidth }),
    '',
  ];
  const aggregatedLine = formatAggregatedSourcesLine(data.aggregatedSources);
  const table = buildTable(data);
  const notes: string[] = [];

  if (table.bodyRows.length === 0 && !aggregatedLine) {
    lines.push(formatNoUsageMessage(options.filtered ?? false));
    return { output: lines.join('\n'), notes };
  }

  if (table.bodyRows.length > 0) {
    const abbreviatedRows = buildTable(data, formatAbbreviatedTokenCount).bodyRows;
    // Measured unwrapped, so a listed row's title reads whole; the wrap sets the width.
    const wrapColumnWidth = [
      table.headers,
      ...wrapTableColumn(table.bodyRows, {
        columnIndex: table.wrapColumnIndex,
        width: MODELS_COLUMN_WIDTH,
      }),
    ].reduce((width, row) => Math.max(width, measureCellWidth(row[table.wrapColumnIndex])), 0);
    const { output, fit } = renderUnicodeTableWithFit({
      headerCells: table.headers.map((header) => roles.header(header)),
      bodyRows: styleContextRows(table, table.bodyRows, roles),
      measureHeaderCells: table.headers,
      measureBodyRows: table.bodyRows,
      rowMetas: table.bodyRows.map(() => ({ periodKey: '', rowKind: 'detail' })),
      columnKinds: columnKindsFromAlign(table.align),
      multilineColumnIndex: table.wrapColumnIndex,
      multilineColumnWidth: wrapColumnWidth,
      terminalWidth,
      fit: {
        abbreviatedBodyRows: styleContextRows(table, abbreviatedRows, roles),
        abbreviatedMeasureBodyRows: abbreviatedRows,
        hideableColumns: table.hideableColumns,
      },
      stackedTitleColumnCount: table.titleColumnCount,
    });
    const fitNote = describeTableFit(fit);

    lines.push(output);
    notes.push(...(fitNote ? [fitNote] : []));
  }

  if (aggregatedLine) {
    lines.push(
      ...(table.bodyRows.length > 0 ? [''] : []),
      splitCellLines(wrapProse(aggregatedLine, terminalWidth)).map(roles.dim).join('\n'),
    );
  }

  return { output: lines.join('\n'), notes };
}

function renderMarkdownContextReport(data: ContextDataResult): string {
  const table = buildTable(data);
  const safeBodyRows = table.bodyRows.map((row) => row.map((cell) => toMarkdownSafeCell(cell)));
  const aggregatedLine = formatAggregatedSourcesLine(data.aggregatedSources);

  return [
    markdownTable([table.headers, ...safeBodyRows], { align: table.align }),
    ...(aggregatedLine ? ['', aggregatedLine] : []),
  ].join('\n');
}

function toJsonPressure(row: ContextPressure) {
  return {
    requests: row.requests,
    peakPromptTokens: row.peakPromptTokens,
    longContextRequests: row.longContextRequests,
    longContextExtraUsd: row.longContextExtraUsd ?? null,
    longContextExtraIncomplete: row.longContextExtraIncomplete === true,
    nearLimitRequests: row.nearLimitRequests ?? null,
  };
}

function toJsonRows(data: ContextDataResult) {
  if (data.grouping === 'session') {
    return data.sessions.map((row) => ({
      source: row.source,
      sessionId: row.sessionId,
      ...(row.repoRoot === undefined ? {} : { repoRoot: row.repoRoot }),
      models: row.models,
      ...toJsonPressure(row),
    }));
  }

  return data.models.map((row) => ({
    model: row.model ?? null,
    contextLimit: row.contextLimit ?? null,
    ...toJsonPressure(row),
  }));
}

export function renderContextReport(
  data: ContextDataResult,
  format: ContextReportFormat,
  options: RenderContextReportOptions = {},
): RenderedContextReport {
  switch (format) {
    case 'json':
      return {
        output: renderReportJson('context', {
          grouping: data.grouping,
          longContextPromptTokens: LONG_CONTEXT_PROMPT_TOKENS,
          nearLimitShare: NEAR_LIMIT_SHARE,
          rows: toJsonRows(data),
          aggregatedSources: data.aggregatedSources,
        }),
        notes: [],
      };
    case 'markdown':
      return { output: renderMarkdownContextReport(data), notes: [] };
    case 'terminal':
      return renderTerminalContextReport(data, options);
  }
}
