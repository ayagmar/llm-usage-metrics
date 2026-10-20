import { markdownTable } from 'markdown-table';

import type { ToolsDataResult } from '../cli/build-tools-data.js';
import type { ToolCallCounts } from '../tools/aggregate-tools.js';
import { formatAbbreviatedTokenCount, formatInteger, formatSharePercent } from './format-number.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import { resolveTtyColumns, truncateTableColumn } from './table-text-layout.js';
import { createColorRoles, type ColorRoles } from './terminal-style-policy.js';
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
  /** The terminal color of a cell; the default color when omitted. */
  style?: (cell: string, roles: ColorRoles) => string;
};

type Table = {
  headers: string[];
  align: ('l' | 'r')[];
  rows: string[][];
  rowMetas: TableRowMeta[];
  /** Leading columns that name a row: the tool and its split keys. */
  titleColumnCount: number;
  /** Text columns a narrow terminal truncates to `FITTED_TEXT_WIDTH`. */
  textColumns: number[];
  /** Columns a narrow terminal hides, least useful first. */
  hideableColumns: number[];
  styles: (Column['style'] | undefined)[];
};

type FormatCount = (value: number) => string;

/** Long MCP tool names and project labels are cut to this in a fitted table. */
const FITTED_TEXT_WIDTH = 28;

const HIDEABLE_HEADERS = ['Unknown', 'Top Project', 'Sessions'];

function buildTable(result: ToolsDataResult, formatCount: FormatCount = formatInteger): Table {
  const { data } = result;
  const titleColumns = [
    { header: 'Tool', align: 'l', cell: (row) => row.label },
    {
      header: 'Source',
      align: 'l',
      shown: data.bySource,
      cell: (row) => row.source,
      style: (cell, roles) => roles.source(cell)(cell),
    },
    { header: 'Project', align: 'l', shown: data.byRepo, cell: (row) => row.project },
  ] satisfies Column[];
  const allColumns: Column[] = [
    ...titleColumns,
    { header: 'Calls', align: 'r', cell: (row) => formatCount(row.calls) },
    { header: 'Errors', align: 'r', cell: (row) => formatCount(row.errors) },
    { header: 'Error Rate', align: 'r', cell: (row) => formatSharePercent(row.errorRate) },
    { header: 'Unknown', align: 'r', cell: (row) => formatCount(row.unknown) },
    { header: 'Sessions', align: 'r', cell: (row) => formatCount(row.sessions) },
    // With --by-repo each row is one project already.
    {
      header: 'Top Project',
      align: 'l',
      shown: !data.byRepo,
      cell: (row) => row.topProject,
      style: (cell, roles) => roles.dim(cell),
    },
  ];
  const columns = allColumns.filter((column) => column.shown ?? true);
  const toolRows = data.rows.map((row) => ({
    row: { ...row, label: row.name, source: row.source ?? '', project: row.project ?? '' },
    meta: { periodKey: '', rowKind: 'detail' as const },
  }));
  const totalRow = {
    row: {
      ...data.totals,
      label:
        data.rows.length < data.rowCount ? `TOTAL (all ${formatInteger(data.rowCount)})` : 'TOTAL',
      source: '',
      project: '',
      topProject: '',
    },
    meta: { periodKey: '', rowKind: 'total' as const },
  };
  const rows = [...toolRows, totalRow];
  const headers = columns.map((column) => column.header);

  return {
    headers,
    align: columns.map((column) => column.align),
    rows: rows.map(({ row }) => columns.map((column) => column.cell(row))),
    rowMetas: rows.map(({ meta }) => meta),
    titleColumnCount: titleColumns.filter((column) => column.shown ?? true).length,
    textColumns: ['Tool', 'Project', 'Top Project']
      .map((header) => headers.indexOf(header))
      .filter((index) => index >= 0),
    hideableColumns: HIDEABLE_HEADERS.map((header) => headers.indexOf(header)).filter(
      (index) => index >= 0,
    ),
    styles: columns.map((column) => column.style),
  };
}

function colorizeRows(rows: string[][], table: Table, roles: ColorRoles): string[][] {
  return rows.map((row) =>
    row.map((cell, columnIndex) => {
      const style = table.styles[columnIndex];
      return style && cell.length > 0 ? style(cell, roles) : cell;
    }),
  );
}

/** Abbreviated counts, with long text cut in the middle so its distinct end stays. */
function buildFittedRows(result: ToolsDataResult, table: Table): string[][] {
  return table.textColumns.reduce(
    (rows, columnIndex) => truncateTableColumn(rows, { columnIndex, width: FITTED_TEXT_WIDTH }),
    buildTable(result, formatAbbreviatedTokenCount).rows,
  );
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

  const roles = createColorRoles(useColor);
  const table = buildTable(result);
  const fittedRows = buildFittedRows(result, table);
  outputLines.push(
    renderUnicodeTable({
      labelStyler: roles.label,
      headerCells: table.headers.map((header) => roles.header(header)),
      bodyRows: colorizeRows(table.rows, table, roles),
      measureHeaderCells: table.headers,
      measureBodyRows: table.rows,
      rowMetas: table.rowMetas,
      columnKinds: columnKindsFromAlign(table.align),
      multilineColumnIndex: 0,
      terminalWidth,
      fit: {
        abbreviatedBodyRows: colorizeRows(fittedRows, table, roles),
        abbreviatedMeasureBodyRows: fittedRows,
        hideableColumns: table.hideableColumns,
      },
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
