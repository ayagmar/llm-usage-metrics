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
import { formatApproxUsd, formatInteger, pluralize } from './format-number.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { renderReportJson } from './report-json.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { formatModels, MODELS_COLUMN_WIDTH, truncateSessionId } from './render-session-report.js';
import { resolveTtyColumns, wrapTableColumn } from './table-text-layout.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { columnKindsFromAlign, renderUnicodeTable } from './unicode-table.js';

export type ContextReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderContextReportOptions = {
  useColor?: boolean;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
};

const LONG_CONTEXT_HEADER = `>${String(LONG_CONTEXT_PROMPT_TOKENS / 1000)}k`;
const NEAR_LIMIT_HEADER = `>${String(NEAR_LIMIT_SHARE * 100)}% limit`;

const pressureHeaders = ['Requests', 'Peak', LONG_CONTEXT_HEADER, 'Tier extra'];

type ContextTable = {
  headers: string[];
  bodyRows: string[][];
  align: ('l' | 'r')[];
  /** The column whose text wraps. */
  wrapColumnIndex: number;
  /** Leading columns that name a row when a narrow terminal lists rows. */
  titleColumnCount: number;
};

function toPressureCells(row: ContextPressure): string[] {
  return [
    formatInteger(row.requests),
    formatInteger(row.peakPromptTokens),
    formatInteger(row.longContextRequests),
    formatApproxUsd(row.longContextExtraUsd, row.longContextExtraIncomplete),
  ];
}

// An unknown limit leaves its cells blank, so it never reads as zero.
function formatOptionalInteger(value: number | undefined): string {
  return value === undefined ? '' : formatInteger(value);
}

function buildModelTable(rows: readonly ContextModelRow[]): ContextTable {
  return {
    headers: ['Model', ...pressureHeaders, 'Limit', NEAR_LIMIT_HEADER],
    bodyRows: rows.map((row) => [
      row.model ?? UNKNOWN_MODEL_LABEL,
      ...toPressureCells(row),
      formatOptionalInteger(row.contextLimit),
      formatOptionalInteger(row.nearLimitRequests),
    ]),
    align: ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
    wrapColumnIndex: 0,
    titleColumnCount: 1,
  };
}

function buildSessionTable(
  rows: readonly ContextSessionRow[],
  projectLabels: ContextDataResult['projectLabels'],
): ContextTable {
  return {
    headers: ['Session', 'Source', 'Project', ...pressureHeaders, NEAR_LIMIT_HEADER, 'Models'],
    bodyRows: rows.map((row) => [
      truncateSessionId(row.sessionId),
      row.source,
      toProjectLabel(row.repoRoot, projectLabels),
      ...toPressureCells(row),
      formatOptionalInteger(row.nearLimitRequests),
      formatModels(row.models),
    ]),
    align: ['l', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'l'],
    wrapColumnIndex: 8,
    titleColumnCount: 1,
  };
}

function buildTable(data: ContextDataResult): ContextTable {
  return data.grouping === 'session'
    ? buildSessionTable(data.sessions, data.projectLabels)
    : buildModelTable(data.models);
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

function renderTerminalContextReport(
  data: ContextDataResult,
  options: RenderContextReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const lines = [renderReportHeader({ title: 'Context Pressure Report', useColor }), ''];
  const aggregatedLine = formatAggregatedSourcesLine(data.aggregatedSources);
  const table = buildTable(data);

  if (table.bodyRows.length === 0 && !aggregatedLine) {
    lines.push(formatNoUsageMessage(options.filtered ?? false));
    return lines.join('\n');
  }

  if (table.bodyRows.length > 0) {
    const wrappedRows = wrapTableColumn(table.bodyRows, {
      columnIndex: table.wrapColumnIndex,
      width: MODELS_COLUMN_WIDTH,
    });

    lines.push(
      renderUnicodeTable({
        headerCells: table.headers,
        bodyRows: wrappedRows,
        measureHeaderCells: table.headers,
        measureBodyRows: wrappedRows,
        rowMetas: wrappedRows.map(() => ({ periodKey: '', rowKind: 'detail' })),
        layout: 'top_aligned',
        columnKinds: columnKindsFromAlign(table.align),
        multilineColumnIndex: table.wrapColumnIndex,
        terminalWidth: resolveTtyColumns(process.stdout),
        stackedTitleColumnCount: table.titleColumnCount,
      }),
    );
  }

  if (aggregatedLine) {
    lines.push(...(table.bodyRows.length > 0 ? [''] : []), aggregatedLine);
  }

  return lines.join('\n');
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
): string {
  switch (format) {
    case 'json':
      return renderReportJson('context', {
        grouping: data.grouping,
        longContextPromptTokens: LONG_CONTEXT_PROMPT_TOKENS,
        nearLimitShare: NEAR_LIMIT_SHARE,
        rows: toJsonRows(data),
        aggregatedSources: data.aggregatedSources,
      });
    case 'markdown':
      return renderMarkdownContextReport(data);
    case 'terminal':
      return renderTerminalContextReport(data, options);
  }
}
