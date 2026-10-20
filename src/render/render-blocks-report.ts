import { markdownTable } from 'markdown-table';

import type { BlockBurnRate } from '../blocks/aggregate-blocks.js';
import type { BlockRow, BlocksReportData } from '../cli/build-blocks-data.js';
import { formatDuration } from './format-duration.js';
import { formatLocalDateTime } from './format-local-date-time.js';
import { formatAbbreviatedTokenCount, formatApproxUsd, formatInteger } from './format-number.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import { formatBulletedList } from './row-cells.js';
import {
  resolveTtyColumns,
  splitCellLines,
  wrapProse,
  wrapTableColumn,
} from './table-text-layout.js';
import { createColorRoles, type ColorRoles } from './terminal-style-policy.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { columnKindsFromAlign, renderUnicodeTable } from './unicode-table.js';

export type BlocksReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderBlocksReportOptions = {
  useColor?: boolean;
  /** Abbreviated token counts without the Reasoning and Cache Write columns. */
  compact?: boolean;
  /** --no-cost: leave cost out. */
  hideCost?: boolean;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
};

const MODELS_COLUMN_WIDTH = 32;
const MODELS_COLUMN_INDEX = 2;
const UNCERTAIN_MARK = '*';
const ACTIVE_MARK = '(active)';

type BlockColumn = {
  header: string;
  /** Hidden by --compact, and first when fitting the table to the terminal. */
  minor?: boolean;
  /** Hidden after the minor columns when the table is still too wide, in this order. */
  fitHideOrder?: number;
  cost?: boolean;
  cell: (row: BlockRow, context: CellContext) => string;
  style?: (cell: string, row: BlockRow, roles: ColorRoles) => string;
};

type CellContext = {
  timezone: string;
  formatTokens: (value: number) => string;
};

function formatCost(value: { costUsd?: number; costIncomplete?: boolean }): string {
  return formatApproxUsd(value.costUsd, value.costIncomplete);
}

/**
 * `2026-06-15 09:00-14:00`, or `2026-06-15 21:00-02:00 (+1d)` across midnight, with the
 * marks for an uncertain start and the active block. A block lasts hours, so it ends on
 * the day it starts or the next one.
 */
function formatBlockSpan(row: BlockRow, timezone: string): string {
  const start = formatLocalDateTime(row.start, timezone);
  const end = formatLocalDateTime(row.end, timezone);
  const nextDay = start.slice(0, 10) === end.slice(0, 10) ? '' : ' (+1d)';
  const marks = [
    row.startUncertain ? UNCERTAIN_MARK : '',
    row.active ? ` ${ACTIVE_MARK}` : '',
  ].join('');
  return `${start}-${end.slice(11)}${nextDay}${marks}`;
}

const blockColumns: readonly BlockColumn[] = [
  { header: 'Block', cell: (row, { timezone }) => formatBlockSpan(row, timezone) },
  {
    header: 'Source',
    cell: (row) => row.source,
    style: (cell, row, roles) => roles.source(row.source)(cell),
  },
  {
    header: 'Models',
    fitHideOrder: 1,
    cell: (row) => formatBulletedList(row.models),
  },
  { header: 'Events', fitHideOrder: 0, cell: (row) => formatInteger(row.eventCount) },
  {
    header: 'Input',
    fitHideOrder: 2,
    cell: (row, { formatTokens }) => formatTokens(row.inputTokens),
  },
  {
    header: 'Output',
    fitHideOrder: 3,
    cell: (row, { formatTokens }) => formatTokens(row.outputTokens),
  },
  {
    header: 'Reasoning',
    minor: true,
    cell: (row, { formatTokens }) => formatTokens(row.reasoningTokens),
  },
  { header: 'Cache Read', cell: (row, { formatTokens }) => formatTokens(row.cacheReadTokens) },
  {
    header: 'Cache Write',
    minor: true,
    cell: (row, { formatTokens }) => formatTokens(row.cacheWriteTokens),
  },
  { header: 'Total', cell: (row, { formatTokens }) => formatTokens(row.totalTokens) },
  {
    header: 'Cost',
    cost: true,
    cell: (row) => formatCost(row),
    style: (cell, _row, roles) => roles.money(cell),
  },
];

function selectVisibleColumns(options: RenderBlocksReportOptions): readonly BlockColumn[] {
  return blockColumns.filter(
    (column) => !(options.compact && column.minor) && !(options.hideCost && column.cost),
  );
}

function buildBodyRows(
  data: BlocksReportData,
  columns: readonly BlockColumn[],
  abbreviated: boolean,
): string[][] {
  const context: CellContext = {
    timezone: data.timezone,
    formatTokens: abbreviated ? formatAbbreviatedTokenCount : (value) => formatInteger(value),
  };

  return data.blocks.map((row) => columns.map((column) => column.cell(row, context)));
}

function buildTable(data: BlocksReportData, options: RenderBlocksReportOptions) {
  const columns = selectVisibleColumns(options);

  return {
    headers: columns.map((column) => column.header),
    bodyRows: buildBodyRows(data, columns, options.compact ?? false),
  };
}

function styleBodyRows(
  data: BlocksReportData,
  columns: readonly BlockColumn[],
  rows: readonly string[][],
  roles: ColorRoles,
): string[][] {
  return rows.map((cells, rowIndex) =>
    cells.map((cell, columnIndex) => {
      const { style } = columns[columnIndex];
      return style ? style(cell, data.blocks[rowIndex], roles) : cell;
    }),
  );
}

/** Minor columns first, then the measures the fitted usage table also gives up. */
function resolveHideableColumns(columns: readonly BlockColumn[]): number[] {
  const indexed = columns.map((column, index) => ({ column, index }));

  return [
    ...indexed.filter(({ column }) => column.minor).map(({ index }) => index),
    ...indexed
      .filter(({ column }) => column.fitHideOrder !== undefined)
      .sort((left, right) => (left.column.fitHideOrder ?? 0) - (right.column.fitHideOrder ?? 0))
      .map(({ index }) => index),
  ];
}

function formatBurnRate(active: BlockBurnRate, options: RenderBlocksReportOptions): string {
  const rates = [`${formatAbbreviatedTokenCount(active.tokensPerHour)} tokens/h`];

  if (!options.hideCost && active.costUsdPerHour !== undefined) {
    rates.unshift(
      `${formatCost({ costUsd: active.costUsdPerHour, costIncomplete: active.costIncomplete })}/h`,
    );
  }

  return rates.join(', ');
}

/** Lines after the table: the window rule, what the marks mean, and the active blocks. */
function buildFooterLines(data: BlocksReportData, options: RenderBlocksReportOptions): string[] {
  const lines = [
    `Blocks are estimated: each starts on the whole UTC hour at or before a source's first event after the previous block and lasts ${String(data.blockHours)} hours, across machines. Times are in ${data.timezone}.${data.since === null ? '' : ' A block that overlaps the start of the window counts in full.'}`,
  ];

  if (data.blocks.some((row) => row.startUncertain)) {
    lines.push(
      `${UNCERTAIN_MARK} Start uncertain: usage before the days read may have started this block earlier.`,
    );
  }

  if (data.top) {
    lines.push(
      `Top ${formatInteger(data.top.count)} of ${formatInteger(data.blockCount)} blocks by ${data.top.rankedBy}.`,
    );
  }

  for (const row of data.activeBlocks) {
    if (row.active) {
      lines.push(
        `Active block (estimated), ${row.source}: ends ${formatLocalDateTime(row.end, data.timezone)}, ${formatDuration(row.active.remainingMinutes * 60_000)} left, burn rate ${formatBurnRate(row.active, options)}.`,
      );
    }
  }

  return lines;
}

/** Block, source and models are text; the columns after them are measures. */
function toColumnAlign(headers: readonly string[]): ('l' | 'r')[] {
  return headers.map((_, index) => (index <= MODELS_COLUMN_INDEX ? 'l' : 'r'));
}

function renderTerminalBlocksReport(
  data: BlocksReportData,
  options: RenderBlocksReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const roles = createColorRoles(useColor);
  const terminalWidth = resolveTtyColumns(process.stdout);
  const outputLines = [
    renderReportHeader({ title: 'Estimated 5-Hour Usage Blocks', useColor, terminalWidth }),
    '',
  ];

  if (data.blocks.length === 0) {
    outputLines.push(formatNoUsageMessage(options.filtered ?? false));
    return outputLines.join('\n');
  }

  const columns = selectVisibleColumns(options);
  const headers = columns.map((column) => column.header);
  // The models column is as wide as its longest model, up to MODELS_COLUMN_WIDTH.
  const wrapModels = (rows: string[][]) =>
    wrapTableColumn(rows, { columnIndex: MODELS_COLUMN_INDEX, width: MODELS_COLUMN_WIDTH });
  const bodyRows = wrapModels(buildBodyRows(data, columns, options.compact ?? false));
  // --compact starts abbreviated, so fitting has no abbreviated step of its own.
  const abbreviatedRows = options.compact
    ? undefined
    : wrapModels(buildBodyRows(data, columns, true));
  // Dim each line on its own, so no style carries across a wrapped line.
  const footer = buildFooterLines(data, options).flatMap((line) =>
    splitCellLines(wrapProse(line, terminalWidth)).map(roles.dim),
  );

  outputLines.push(
    renderUnicodeTable({
      headerCells: headers.map(roles.header),
      bodyRows: styleBodyRows(data, columns, bodyRows, roles),
      measureHeaderCells: headers,
      measureBodyRows: bodyRows,
      rowMetas: bodyRows.map(() => ({ periodKey: '', rowKind: 'detail' })),
      columnKinds: columnKindsFromAlign(toColumnAlign(headers)),
      multilineColumnIndex: MODELS_COLUMN_INDEX,
      terminalWidth,
      fit: {
        ...(abbreviatedRows
          ? {
              abbreviatedBodyRows: styleBodyRows(data, columns, abbreviatedRows, roles),
              abbreviatedMeasureBodyRows: abbreviatedRows,
            }
          : {}),
        hideableColumns: resolveHideableColumns(columns),
      },
      stackedTitleColumnCount: MODELS_COLUMN_INDEX,
    }),
    '',
    ...footer,
  );

  return outputLines.join('\n');
}

function renderMarkdownBlocksReport(
  data: BlocksReportData,
  options: RenderBlocksReportOptions,
): string {
  if (data.blocks.length === 0) {
    return `Estimated 5-hour usage blocks: ${formatNoUsageMessage(options.filtered ?? false)}`;
  }

  const { headers, bodyRows } = buildTable(data, options);
  const safeBodyRows = bodyRows.map((row) => row.map((cell) => toMarkdownSafeCell(cell)));
  const table = markdownTable([headers, ...safeBodyRows], {
    align: toColumnAlign(headers),
  });

  // One paragraph per line.
  return [table, ...buildFooterLines(data, options).map(toMarkdownSafeCell)].join('\n\n');
}

export function renderBlocksReport(
  data: BlocksReportData,
  format: BlocksReportFormat,
  options: RenderBlocksReportOptions = {},
): string {
  switch (format) {
    case 'json':
      return renderReportJson('blocks', data);
    case 'markdown':
      return renderMarkdownBlocksReport(data, options);
    case 'terminal':
      return renderTerminalBlocksReport(data, options);
  }
}
