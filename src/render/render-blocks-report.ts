import { markdownTable } from 'markdown-table';

import type { BlockBurnRate } from '../blocks/aggregate-blocks.js';
import type { BlockRow, BlocksReportData } from '../cli/build-blocks-data.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import { formatAbbreviatedTokenCount } from './row-cells.js';
import { resolveTtyColumns, wrapTableColumn } from './table-text-layout.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { renderUnicodeTable } from './unicode-table.js';

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

const integerFormatter = new Intl.NumberFormat('en-US');
const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatLocalDateTime(isoTimestamp: string, timezone: string): string {
  let formatter = dateTimeFormatters.get(timezone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    dateTimeFormatters.set(timezone, formatter);
  }

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(isoTimestamp)).map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function formatCost(value: { costUsd?: number; costIncomplete?: boolean }): string {
  if (value.costUsd === undefined) {
    return '-';
  }

  const formatted = usdFormatter.format(value.costUsd);
  return value.costIncomplete ? `~${formatted}` : formatted;
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
  const start = formatLocalDateTime(row.start, timezone);
  const end = formatLocalDateTime(row.end, timezone);
  const sameDay = start.slice(0, 10) === end.slice(0, 10);

  return `${start}-${sameDay ? end.slice(11) : end}${marks}`;
}

const blockColumns: readonly BlockColumn[] = [
  { header: 'Block', cell: (row, { timezone }) => formatBlockSpan(row, timezone) },
  { header: 'Source', cell: (row) => row.source },
  {
    header: 'Models',
    cell: (row) => (row.models.length === 0 ? '-' : row.models.map((m) => `• ${m}`).join('\n')),
  },
  { header: 'Events', cell: (row) => integerFormatter.format(row.eventCount) },
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
    formatTokens: options.compact
      ? formatAbbreviatedTokenCount
      : (value) => integerFormatter.format(value),
  };

  return {
    headers: columns.map((column) => column.header),
    bodyRows: data.blocks.map((row) => columns.map((column) => column.cell(row, context))),
  };
}

function formatBurnRate(active: BlockBurnRate, options: RenderBlocksReportOptions): string {
  const rates = [`${integerFormatter.format(active.tokensPerHour)} tokens/h`];

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
    align: headers.map((_, index) => (index <= MODELS_COLUMN_INDEX ? 'l' : 'r')),
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
