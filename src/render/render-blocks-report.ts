import { markdownTable } from 'markdown-table';

import type { BlockBurnRate } from '../blocks/aggregate-blocks.js';
import type { BlockRow, BlocksReportData } from '../cli/build-blocks-data.js';
import { formatLocalDateTime, formatLocalDateTimeSpan } from './format-local-date-time.js';
import { formatAbbreviatedTokenCount, formatApproxUsd, formatInteger } from './format-number.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import { formatBulletedList } from './row-cells.js';
import { resolveTtyColumns, wrapTableColumn } from './table-text-layout.js';
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
  /** Hidden by --compact. */
  minor?: boolean;
  cost?: boolean;
  cell: (row: BlockRow, context: CellContext) => string;
};

type CellContext = {
  timezone: string;
  formatTokens: (value: number) => string;
};

function formatCost(value: { costUsd?: number; costIncomplete?: boolean }): string {
  return formatApproxUsd(value.costUsd, value.costIncomplete);
}

/**
 * `2026-06-15 09:00-14:00`, or `2026-06-15 21:00-2026-06-16 02:00` across midnight, with
 * the marks for an uncertain start and the active block.
 */
function formatBlockSpan(row: BlockRow, timezone: string): string {
  const marks = [
    row.startUncertain ? UNCERTAIN_MARK : '',
    row.active ? ` ${ACTIVE_MARK}` : '',
  ].join('');
  return `${formatLocalDateTimeSpan(row.start, row.end, timezone)}${marks}`;
}

const blockColumns: readonly BlockColumn[] = [
  { header: 'Block', cell: (row, { timezone }) => formatBlockSpan(row, timezone) },
  { header: 'Source', cell: (row) => row.source },
  {
    header: 'Models',
    cell: (row) => formatBulletedList(row.models),
  },
  { header: 'Events', cell: (row) => formatInteger(row.eventCount) },
  { header: 'Input', cell: (row, { formatTokens }) => formatTokens(row.inputTokens) },
  { header: 'Output', cell: (row, { formatTokens }) => formatTokens(row.outputTokens) },
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
  { header: 'Cost', cost: true, cell: (row) => formatCost(row) },
];

function selectVisibleColumns(options: RenderBlocksReportOptions): readonly BlockColumn[] {
  return blockColumns.filter(
    (column) => !(options.compact && column.minor) && !(options.hideCost && column.cost),
  );
}

function buildTable(data: BlocksReportData, options: RenderBlocksReportOptions) {
  const columns = selectVisibleColumns(options);
  const context: CellContext = {
    timezone: data.timezone,
    formatTokens: options.compact ? formatAbbreviatedTokenCount : (value) => formatInteger(value),
  };

  return {
    headers: columns.map((column) => column.header),
    bodyRows: data.blocks.map((row) => columns.map((column) => column.cell(row, context))),
  };
}

function formatBurnRate(active: BlockBurnRate, options: RenderBlocksReportOptions): string {
  const rates = [`${formatInteger(active.tokensPerHour)} tokens/h`];

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
    `Blocks are estimated: each starts at the UTC hour of a source's first event after the previous block and lasts ${String(data.blockHours)} hours (times in ${data.timezone}), across machines.`,
  ];

  if (data.blocks.some((row) => row.startUncertain)) {
    lines.push(
      `${UNCERTAIN_MARK} Start uncertain: usage before the days read may have started this block earlier.`,
    );
  }

  if (data.top) {
    lines.push(
      `Top ${String(data.top.count)} of ${String(data.blockCount)} blocks by ${data.top.rankedBy}.`,
    );
  }

  for (const row of data.activeBlocks) {
    if (row.active) {
      lines.push(
        `Active block (estimated), ${row.source}: ends ${formatLocalDateTime(row.end, data.timezone)}, ${String(row.active.remainingMinutes)} min left, burn rate ${formatBurnRate(row.active, options)}.`,
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
  const outputLines = [
    renderReportHeader({ title: 'Estimated 5-Hour Usage Blocks', useColor }),
    '',
  ];

  if (data.blocks.length === 0) {
    outputLines.push(formatNoUsageMessage(options.filtered ?? false));
    return outputLines.join('\n');
  }

  const { headers, bodyRows } = buildTable(data, options);
  const wrappedRows = wrapTableColumn(bodyRows, {
    columnIndex: MODELS_COLUMN_INDEX,
    width: MODELS_COLUMN_WIDTH,
  });

  outputLines.push(
    renderUnicodeTable({
      headerCells: headers,
      bodyRows: wrappedRows,
      measureHeaderCells: headers,
      measureBodyRows: wrappedRows,
      rowMetas: wrappedRows.map(() => ({ periodKey: '', rowKind: 'detail' })),
      layout: 'top_aligned',
      columnKinds: columnKindsFromAlign(toColumnAlign(headers)),
      multilineColumnIndex: MODELS_COLUMN_INDEX,
      multilineColumnWidth: MODELS_COLUMN_WIDTH,
      terminalWidth: resolveTtyColumns(process.stdout),
      stackedTitleColumnCount: MODELS_COLUMN_INDEX,
    }),
    '',
    ...buildFooterLines(data, options),
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
