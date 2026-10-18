import { markdownTable } from 'markdown-table';

import type { ToolsDataResult } from '../cli/build-tools-data.js';
import type { ToolCallCounts } from '../tools/aggregate-tools.js';
import { formatInteger, formatSharePercent } from './format-number.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import { resolveTtyColumns } from './table-text-layout.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { columnKindsFromAlign, renderUnicodeTable, type TableRowMeta } from './unicode-table.js';

export type ToolsReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderToolsReportOptions = {
  useColor?: boolean;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
  terminalWidth?: number;
};

/** A tool row or the TOTAL row, in one shape. */
type ToolTableRow = ToolCallCounts & {
  label: string;
  source: string;
  project: string;
  topProject: string;
};

type Column = {
  header: string;
  align: 'l' | 'r';
  /** False drops the column. */
  shown?: boolean;
  cell: (row: ToolTableRow) => string;
};

type Table = {
  headers: string[];
  align: ('l' | 'r')[];
  rows: string[][];
  rowMetas: TableRowMeta[];
  /** Leading columns that name a row: the tool and its split keys. */
  titleColumnCount: number;
};

function buildTable(result: ToolsDataResult): Table {
  const { data } = result;
  const titleColumns = [
    { header: 'Tool', align: 'l', cell: (row) => row.label },
    { header: 'Source', align: 'l', shown: data.bySource, cell: (row) => row.source },
    { header: 'Project', align: 'l', shown: data.byRepo, cell: (row) => row.project },
  ] satisfies Column[];
  const allColumns: Column[] = [
    ...titleColumns,
    { header: 'Calls', align: 'r', cell: (row) => formatInteger(row.calls) },
    { header: 'Errors', align: 'r', cell: (row) => formatInteger(row.errors) },
    { header: 'Error Rate', align: 'r', cell: (row) => formatSharePercent(row.errorRate) },
    { header: 'Unknown', align: 'r', cell: (row) => formatInteger(row.unknown) },
    { header: 'Sessions', align: 'r', cell: (row) => formatInteger(row.sessions) },
    // With --by-repo each row is one project already.
    { header: 'Top Project', align: 'l', shown: !data.byRepo, cell: (row) => row.topProject },
  ];
  const columns = allColumns.filter((column) => column.shown ?? true);
  const toolRows = data.rows.map((row) => ({
    row: { ...row, label: row.name, source: row.source ?? '', project: row.project ?? '' },
    meta: { periodKey: '', rowKind: 'detail' as const },
  }));
  const totalRow = {
    row: {
      ...data.totals,
      label: data.rows.length < data.rowCount ? `TOTAL (all ${String(data.rowCount)})` : 'TOTAL',
      source: '',
      project: '',
      topProject: '',
    },
    meta: { periodKey: '', rowKind: 'total' as const },
  };
  const rows = [...toolRows, totalRow];

  return {
    headers: columns.map((column) => column.header),
    align: columns.map((column) => column.align),
    rows: rows.map(({ row }) => columns.map((column) => column.cell(row))),
    rowMetas: rows.map(({ meta }) => meta),
    titleColumnCount: titleColumns.filter((column) => column.shown ?? true).length,
  };
}

function renderTerminalToolsReport(
  result: ToolsDataResult,
  options: RenderToolsReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const terminalWidth = options.terminalWidth ?? resolveTtyColumns(process.stdout);
  const outputLines = [
    renderReportHeader({ title: 'Tool Calls Report', useColor, terminalWidth }),
    '',
  ];

  if (result.data.rows.length === 0) {
    outputLines.push(formatNoUsageMessage(options.filtered ?? false, undefined, 'tool calls'));
    return outputLines.join('\n');
  }

  const table = buildTable(result);
  outputLines.push(
    renderUnicodeTable({
      headerCells: table.headers,
      bodyRows: table.rows,
      measureHeaderCells: table.headers,
      measureBodyRows: table.rows,
      rowMetas: table.rowMetas,
      layout: 'top_aligned',
      columnKinds: columnKindsFromAlign(table.align),
      multilineColumnIndex: 0,
      terminalWidth,
      stackedTitleColumnCount: table.titleColumnCount,
    }),
  );

  return outputLines.join('\n');
}

/** Always a table, as `projects`: an empty window keeps its TOTAL row. */
function renderMarkdownToolsReport(result: ToolsDataResult): string {
  const table = buildTable(result);

  return markdownTable(
    [table.headers, ...table.rows.map((row) => row.map((cell) => toMarkdownSafeCell(cell)))],
    { align: table.align },
  );
}

export function renderToolsReport(
  result: ToolsDataResult,
  format: ToolsReportFormat,
  options: RenderToolsReportOptions = {},
): string {
  switch (format) {
    case 'json':
      return renderReportJson('tools', result.data);
    case 'markdown':
      return renderMarkdownToolsReport(result);
    case 'terminal':
      return renderTerminalToolsReport(result, options);
  }
}
