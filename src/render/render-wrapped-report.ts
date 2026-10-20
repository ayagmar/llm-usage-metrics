import { markdownTable } from 'markdown-table';

import type { WrappedRecap, WrappedTopItem } from '../wrapped/wrapped-recap.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { formatHours } from './format-duration.js';
import { pluralize } from '@ayagmar/agent-sessions/internal';
import { formatAbbreviatedTokenCount, formatApproxUsd, formatInteger } from './format-number.js';
import { resolveTerminalWidth, visibleWidth, wrapProse } from './table-text-layout.js';
import {
  createColorRoles,
  defaultTerminalStylePalette,
  type ColorRoles,
  type TerminalStylePalette,
  type TextStyler,
} from './terminal-style-policy.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';
import { renderReportJson } from './report-json.js';
import { MONTH_LABELS } from './month-labels.js';
import { SPARKLINE_GLYPHS, SPARKLINE_TOP_LEVEL, sparklineLevel } from './sparkline.js';

export type WrappedReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderWrappedReportOptions = {
  useColor?: boolean;
  palette?: TerminalStylePalette;
  /** Overrides the TTY width the header, monthly strip, and top tables are fitted to. */
  terminalWidth?: number;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
};

export const wrappedReportFormats = [
  'terminal',
  'markdown',
  'json',
] as const satisfies readonly WrappedReportFormat[];

// A month without usage; the sparkline's blank would read as a gap in the strip.
const IDLE_MONTH_GLYPH = '·';
const TOP_MODELS_HEADERS = ['#', 'Model', 'Tokens', 'Cost'] as const;
const TOP_SOURCES_HEADERS = ['#', 'Source', 'Tokens', 'Cost'] as const;
const TOP_ITEM_RANK_COLUMN = 0;
const TOP_ITEM_NAME_COLUMN = 1;
// `Jan ▁`, two spaces apart; a strip too wide for the terminal breaks into equal rows.
const MONTH_ENTRY_WIDTH = 5;
const MONTH_ENTRY_GAP = 2;
const MONTHS_PER_ROW_STEPS = [12, 6, 4, 3, 2, 1] as const;

/** Gates a styler behind the color policy so `useColor: false` never emits ANSI. */
type Paint = (styler: TextStyler) => TextStyler;

function formatPeakHour(peakHour: WrappedRecap['peakHour']): string {
  return peakHour === undefined ? '-' : `${String(peakHour.hour).padStart(2, '0')}:00`;
}

function formatBusiestDay(busiestDay: WrappedRecap['busiestDay']): string {
  return busiestDay === undefined
    ? '-'
    : `${busiestDay.date} (${formatAbbreviatedTokenCount(busiestDay.totalTokens)} tokens)`;
}

/** The weekday share of the year's tokens, or undefined without any tokens. */
function formatWeekdayShare(recap: WrappedRecap): string | undefined {
  const totalSplitTokens = recap.weekdayTokens + recap.weekendTokens;

  return totalSplitTokens > 0
    ? `${Math.round((100 * recap.weekdayTokens) / totalSplitTokens)}% of tokens`
    : undefined;
}

function renderStatLines(recap: WrappedRecap, roles: ColorRoles): string {
  const weekdayShare = formatWeekdayShare(recap);
  const stats: { label: string; value: string; styler?: TextStyler }[] = [
    { label: 'Tokens', value: formatInteger(recap.totalTokens) },
    {
      label: 'Cost',
      value: formatApproxUsd(recap.costUsd, recap.costIncomplete),
      styler: roles.money,
    },
    { label: 'Active days', value: formatInteger(recap.activeDays) },
    { label: 'Longest streak', value: pluralize(recap.longestStreak, 'day') },
    { label: 'Hours', value: formatHours(recap.activeMs) },
    { label: 'Peak hour', value: formatPeakHour(recap.peakHour) },
  ];

  if (weekdayShare !== undefined) {
    stats.push({ label: 'Weekdays', value: weekdayShare });
  }

  stats.push({ label: 'Busiest day', value: formatBusiestDay(recap.busiestDay) });

  if (recap.estimatedCacheSavingsUsd !== undefined) {
    stats.push({
      label: 'Cache savings',
      value: formatApproxUsd(recap.estimatedCacheSavingsUsd, true),
      styler: roles.positive,
    });
  }

  stats.push(
    { label: 'Events', value: formatInteger(recap.eventCount) },
    { label: 'Sessions', value: formatInteger(recap.sessionCount) },
  );

  const labelWidth = stats.reduce((max, stat) => Math.max(max, stat.label.length), 0);

  return stats
    .map(
      (stat) =>
        `${roles.label(stat.label.padEnd(labelWidth))}  ${(stat.styler ?? roles.value)(stat.value)}`,
    )
    .join('\n');
}

/** The most months per row that fit `terminalWidth`: 12, then halves, quarters, and so on. */
function resolveMonthsPerRow(terminalWidth: number | undefined): number {
  return (
    MONTHS_PER_ROW_STEPS.find(
      (count) =>
        terminalWidth === undefined ||
        count * MONTH_ENTRY_WIDTH + (count - 1) * MONTH_ENTRY_GAP <= terminalWidth,
    ) ?? 1
  );
}

function renderMonthlyStrip(
  recap: WrappedRecap,
  paint: Paint,
  palette: TerminalStylePalette,
  terminalWidth: number | undefined,
): string {
  const boldGreen: TextStyler = (text) => palette.bold(palette.green(text));
  const maxTokens = Math.max(0, ...recap.monthlyIntensity.map((month) => month.totalTokens));
  const monthsPerRow = resolveMonthsPerRow(terminalWidth);
  const entries = recap.monthlyIntensity.map((month, index) => {
    const level = sparklineLevel(month.totalTokens, maxTokens);
    const glyph = level === 0 ? IDLE_MONTH_GLYPH : SPARKLINE_GLYPHS[level];
    const label = MONTH_LABELS[index] ?? month.month;
    const glyphStyler =
      level === 0 ? palette.dim : level > SPARKLINE_TOP_LEVEL / 2 ? boldGreen : palette.green;

    return `${paint(palette.dim)(label)} ${paint(glyphStyler)(glyph)}`;
  });
  const rows: string[] = [];

  for (let start = 0; start < entries.length; start += monthsPerRow) {
    rows.push(entries.slice(start, start + monthsPerRow).join(' '.repeat(MONTH_ENTRY_GAP)));
  }

  return rows.join('\n');
}

type TopItemRowStyle = {
  formatTokens: (tokens: number) => string;
  money: TextStyler;
  name: TextStyler;
};

const plainTopItemRowStyle: TopItemRowStyle = {
  formatTokens: formatInteger,
  money: (text) => text,
  name: (text) => text,
};

function toTopItemRows(
  items: readonly WrappedTopItem[],
  style: TopItemRowStyle = plainTopItemRowStyle,
): string[][] {
  if (items.length === 0) {
    return [['-', '-', '-', '-']];
  }

  return items.map((item, index) => [
    String(index + 1),
    style.name(item.name),
    style.formatTokens(item.totalTokens),
    style.money(formatApproxUsd(item.costUsd, item.costIncomplete)),
  ]);
}

function renderTopTable(
  headerCells: readonly string[],
  items: readonly WrappedTopItem[],
  options: { roles: ColorRoles; name: TextStyler; terminalWidth: number | undefined },
): string {
  const { roles } = options;
  const toRows = (formatTokens: TopItemRowStyle['formatTokens'], colored: boolean) =>
    toTopItemRows(
      items,
      colored
        ? { formatTokens, money: roles.money, name: options.name }
        : { ...plainTopItemRowStyle, formatTokens },
    );
  const measureBodyRows = toRows(formatInteger, false);
  const nameCells = [
    headerCells[TOP_ITEM_NAME_COLUMN],
    ...measureBodyRows.map((row) => row[TOP_ITEM_NAME_COLUMN]),
  ];
  const nameColumnWidth = nameCells.reduce((max, cell) => Math.max(max, visibleWidth(cell)), 0);
  const rowMetas: TableRowMeta[] = measureBodyRows.map(() => ({
    periodKey: 'wrapped',
    rowKind: 'detail',
  }));

  return renderUnicodeTable({
    labelStyler: roles.label,
    headerCells: headerCells.map((header) => roles.header(header)),
    bodyRows: toRows(formatInteger, true),
    measureHeaderCells: headerCells,
    measureBodyRows,
    rowMetas,
    columnKinds: ['text', 'text', 'measure', 'measure'],
    multilineColumnIndex: TOP_ITEM_NAME_COLUMN,
    multilineColumnWidth: nameColumnWidth,
    terminalWidth: options.terminalWidth,
    fit: {
      abbreviatedBodyRows: toRows(formatAbbreviatedTokenCount, true),
      abbreviatedMeasureBodyRows: toRows(formatAbbreviatedTokenCount, false),
      hideableColumns: [TOP_ITEM_RANK_COLUMN],
    },
  });
}

function toEmptyMessage(recap: WrappedRecap, filtered: boolean): string | undefined {
  if (recap.eventCount > 0) {
    return undefined;
  }

  return formatNoUsageMessage(filtered, `in ${recap.year}`);
}

function renderWrappedTerminalReport(
  recap: WrappedRecap,
  options: RenderWrappedReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const palette = options.palette ?? defaultTerminalStylePalette;
  const paint: Paint = (styler) => (text) => (useColor ? styler(text) : text);
  const roles = createColorRoles(useColor, palette);
  const terminalWidth = resolveTerminalWidth(options.terminalWidth);
  const heading = [
    renderReportHeader({ title: `Wrapped ${recap.year}`, useColor, terminalWidth }),
    '',
    ...wrapProse(`${recap.from} to ${recap.to} (${recap.timezone})`, terminalWidth)
      .split('\n')
      .map((line) => roles.dim(line)),
    '',
  ];
  const emptyMessage = toEmptyMessage(recap, options.filtered ?? false);

  if (emptyMessage) {
    return [...heading, wrapProse(emptyMessage, terminalWidth)].join('\n');
  }

  return [
    ...heading,
    renderStatLines(recap, roles),
    '',
    'Monthly activity',
    renderMonthlyStrip(recap, paint, palette, terminalWidth),
    '',
    'Top models',
    renderTopTable(TOP_MODELS_HEADERS, recap.topModels, {
      roles,
      name: roles.value,
      terminalWidth,
    }),
    '',
    'Top sources',
    renderTopTable(TOP_SOURCES_HEADERS, recap.topSources, {
      roles,
      name: (source) => roles.source(source)(source),
      terminalWidth,
    }),
  ].join('\n');
}

function toMarkdownStatRows(recap: WrappedRecap): string[][] {
  return [
    ['Tokens', formatInteger(recap.totalTokens)],
    ['Cost', formatApproxUsd(recap.costUsd, recap.costIncomplete)],
    ['Hours', formatHours(recap.activeMs)],
    ['Active days', formatInteger(recap.activeDays)],
    ['Longest streak', pluralize(recap.longestStreak, 'day')],
    ['Events', formatInteger(recap.eventCount)],
    ['Sessions', formatInteger(recap.sessionCount)],
    ['Peak hour', formatPeakHour(recap.peakHour)],
    ['Weekdays', formatWeekdayShare(recap) ?? '-'],
    ['Busiest day', formatBusiestDay(recap.busiestDay)],
    [
      'Cache savings',
      recap.estimatedCacheSavingsUsd === undefined
        ? '-'
        : formatApproxUsd(recap.estimatedCacheSavingsUsd, true),
    ],
  ];
}

function renderMarkdownTopTable(title: string, items: readonly WrappedTopItem[]): string {
  const rows = toTopItemRows(items);

  return [
    `### ${title}`,
    '',
    markdownTable(
      [['#', title === 'Top models' ? 'Model' : 'Source', 'Tokens', 'Cost'], ...rows].map((row) =>
        row.map((cell) => toMarkdownSafeCell(cell)),
      ),
      { align: ['r', 'l', 'r', 'r'] },
    ),
  ].join('\n');
}

function renderMarkdownWrappedReport(recap: WrappedRecap): string {
  const statTable = markdownTable(
    [['Stat', 'Value'], ...toMarkdownStatRows(recap)].map((row) =>
      row.map((cell) => toMarkdownSafeCell(cell)),
    ),
    { align: ['l', 'r'] },
  );

  return [
    `### Wrapped ${recap.year}`,
    '',
    `${recap.from} to ${recap.to} (${recap.timezone})`,
    '',
    statTable,
    '',
    renderMarkdownTopTable('Top models', recap.topModels),
    '',
    renderMarkdownTopTable('Top sources', recap.topSources),
  ].join('\n');
}

export function renderWrappedReport(
  recap: WrappedRecap,
  format: WrappedReportFormat,
  options: RenderWrappedReportOptions = {},
): string {
  switch (format) {
    case 'json':
      return renderReportJson('wrapped', recap);
    case 'markdown':
      return renderMarkdownWrappedReport(recap);
    case 'terminal':
      return renderWrappedTerminalReport(recap, options);
  }
}
