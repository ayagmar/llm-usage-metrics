import { markdownTable } from 'markdown-table';

import type { ProjectsData } from '../cli/build-projects-data.js';
import type { PeriodProjectRow, UsageTotals } from '../domain/usage-report-row.js';
import {
  formatAbbreviatedTokenCount,
  formatApproxUsd,
  formatInteger,
  formatSharePercent,
} from './format-number.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import { formatBulletedList } from './row-cells.js';
import { resolveTtyColumns } from './table-text-layout.js';
import { createColorRoles, type TextStyler } from './terminal-style-policy.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { describeTableFit, type RenderedReportWithNotes } from './table-fit-note.js';
import {
  columnKindsFromAlign,
  renderUnicodeTableWithFit,
  type TableRowMeta,
} from './unicode-table.js';

export type ProjectsReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderProjectsReportOptions = {
  useColor?: boolean;
  /** Abbreviated token counts without the Events and Active Days columns. */
  compact?: boolean;
  /** `--no-cost`: leaves out Cost and Share. */
  hideCost?: boolean;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
  terminalWidth?: number;
};

type Column<Row> = {
  header: string;
  align: 'l' | 'r';
  cell: (row: Row) => string;
  /** `cost` columns drop with --no-cost, `minor` ones with --compact. */
  kind?: 'cost' | 'minor';
};

type Table = {
  headers: string[];
  align: ('l' | 'r')[];
  rows: string[][];
  rowMetas: TableRowMeta[];
};

const TOP_MODEL_COUNT = 3;

const PERIOD_NAMES = { daily: 'Day', weekly: 'Week', monthly: 'Month' } as const;

/** The column that wraps; the columns before it name a stacked row. */
const MODELS_HEADER = 'Models';

function formatCost(totals: UsageTotals): string {
  return formatApproxUsd(totals.costUsd, totals.costIncomplete);
}

function createTokenFormatter(compact: boolean): (value: number) => string {
  return compact ? formatAbbreviatedTokenCount : formatInteger;
}

function selectColumns<Row>(
  columns: readonly Column<Row>[],
  options: RenderProjectsReportOptions,
): Column<Row>[] {
  return columns.filter(
    (column) =>
      !(column.kind === 'cost' && options.hideCost) &&
      !(column.kind === 'minor' && options.compact),
  );
}

function toTable<Row>(
  columns: readonly Column<Row>[],
  rows: readonly { row: Row; meta: TableRowMeta }[],
): Table {
  return {
    headers: columns.map((column) => column.header),
    align: columns.map((column) => column.align),
    rows: rows.map(({ row }) => columns.map((column) => column.cell(row))),
    rowMetas: rows.map(({ meta }) => meta),
  };
}

/** A project row or the TOTAL row, in one shape. */
type ProjectTableRow = UsageTotals & {
  label: string;
  models: readonly string[];
  costShare: number | null;
  events: number;
  activeDays: number;
};

function toTotalTableRow(data: ProjectsData): ProjectTableRow {
  const { totals } = data;

  return {
    ...totals,
    label:
      data.projects.length < totals.projects ? `TOTAL (all ${String(totals.projects)})` : 'TOTAL',
    models: [],
    costShare: (totals.costUsd ?? 0) > 0 ? 1 : null,
  };
}

function buildProjectTable(data: ProjectsData, options: RenderProjectsReportOptions): Table {
  const formatTokens = createTokenFormatter(options.compact ?? false);
  const columns: Column<ProjectTableRow>[] = [
    { header: 'Project', align: 'l', cell: (row) => row.label },
    {
      header: MODELS_HEADER,
      align: 'l',
      cell: (row) => (row.models.length === 0 ? '' : formatBulletedList(row.models)),
    },
    { header: 'Cost', align: 'r', kind: 'cost', cell: formatCost },
    { header: 'Share', align: 'r', kind: 'cost', cell: (row) => formatSharePercent(row.costShare) },
    { header: 'Tokens', align: 'r', cell: (row) => formatTokens(row.totalTokens) },
    {
      header: 'Events',
      align: 'r',
      kind: 'minor',
      cell: (row) => formatInteger(row.events),
    },
    {
      header: 'Active Days',
      align: 'r',
      kind: 'minor',
      cell: (row) => formatInteger(row.activeDays),
    },
  ];
  const projectRows = data.projects.map((row) => ({
    row: { ...row, label: row.project, models: row.topModels },
    meta: { periodKey: '', rowKind: 'detail' as const },
  }));

  return toTable(selectColumns(columns, options), [
    ...projectRows,
    { row: toTotalTableRow(data), meta: { periodKey: '', rowKind: 'total' } },
  ]);
}

function buildPeriodTable(
  data: ProjectsData,
  periods: readonly PeriodProjectRow[],
  options: RenderProjectsReportOptions,
): Table {
  const formatTokens = createTokenFormatter(options.compact ?? false);
  const columns: Column<PeriodProjectRow>[] = [
    {
      header: data.granularity ? PERIOD_NAMES[data.granularity] : 'Period',
      align: 'l',
      cell: (row) => row.periodKey,
    },
    { header: 'Project', align: 'l', cell: (row) => row.project },
    {
      header: MODELS_HEADER,
      align: 'l',
      cell: (row) => formatBulletedList(row.models.slice(0, TOP_MODEL_COUNT)),
    },
    { header: 'Cost', align: 'r', kind: 'cost', cell: formatCost },
    { header: 'Tokens', align: 'r', cell: (row) => formatTokens(row.totalTokens) },
  ];

  return toTable(
    selectColumns(columns, options),
    periods.map((row) => ({ row, meta: { periodKey: row.periodKey, rowKind: 'detail' } })),
  );
}

function buildTables(data: ProjectsData, options: RenderProjectsReportOptions): Table[] {
  const tables = [buildProjectTable(data, options)];

  if (data.periods && data.periods.length > 0) {
    tables.push(buildPeriodTable(data, data.periods, options));
  }

  return tables;
}

function renderTerminalTable(
  table: Table,
  options: { terminalWidth: number | undefined; labelStyler: TextStyler },
) {
  const { terminalWidth, labelStyler } = options;
  const modelsColumnIndex = table.headers.indexOf(MODELS_HEADER);

  return renderUnicodeTableWithFit({
    labelStyler: labelStyler,
    headerCells: table.headers,
    bodyRows: table.rows,
    measureHeaderCells: table.headers,
    measureBodyRows: table.rows,
    rowMetas: table.rowMetas,
    columnKinds: columnKindsFromAlign(table.align),
    multilineColumnIndex: modelsColumnIndex,
    terminalWidth,
    stackedTitleColumnCount: modelsColumnIndex,
  });
}

function renderTerminalProjectsReport(
  data: ProjectsData,
  options: RenderProjectsReportOptions,
): RenderedReportWithNotes {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const terminalWidth = options.terminalWidth ?? resolveTtyColumns(process.stdout);
  const outputLines = [
    renderReportHeader({ title: 'Project Usage Report', useColor, terminalWidth }),
    '',
  ];

  if (data.projects.length === 0) {
    outputLines.push(formatNoUsageMessage(options.filtered ?? false));
    return { output: outputLines.join('\n'), notes: [] };
  }

  const labelStyler = createColorRoles(useColor).label;
  const tables = buildTables(data, options).map((table) =>
    renderTerminalTable(table, { terminalWidth, labelStyler }),
  );
  const fitNote = describeTableFit(...tables.map((table) => table.fit));

  outputLines.push(tables.map((table) => table.output).join('\n\n'));

  return { output: outputLines.join('\n'), notes: fitNote ? [fitNote] : [] };
}

/** Always tables, as the usage reports: an empty window keeps its TOTAL row. */
function renderMarkdownProjectsReport(
  data: ProjectsData,
  options: RenderProjectsReportOptions,
): string {
  return buildTables(data, options)
    .map((table) =>
      markdownTable(
        [table.headers, ...table.rows.map((row) => row.map((cell) => toMarkdownSafeCell(cell)))],
        { align: table.align },
      ),
    )
    .join('\n\n');
}

export function renderProjectsReportWithNotes(
  data: ProjectsData,
  format: ProjectsReportFormat,
  options: RenderProjectsReportOptions = {},
): RenderedReportWithNotes {
  switch (format) {
    case 'json':
      return {
        output: renderReportJson('projects', {
          totals: data.totals,
          projects: data.projects,
          ...(data.granularity ? { granularity: data.granularity } : {}),
          ...(data.periods ? { periods: data.periods } : {}),
        }),
        notes: [],
      };
    case 'markdown':
      return { output: renderMarkdownProjectsReport(data, options), notes: [] };
    case 'terminal':
      return renderTerminalProjectsReport(data, options);
  }
}
