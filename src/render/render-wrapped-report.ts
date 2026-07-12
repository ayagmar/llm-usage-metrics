import type { WrappedRecap, WrappedTopItem } from '../wrapped/wrapped-recap.js';
import { renderReportHeader } from './report-header.js';
import { formatApproxUsd, formatInteger } from './share-svg-theme.js';
import { visibleWidth } from './table-text-layout.js';
import {
  defaultTerminalStylePalette,
  type TerminalStylePalette,
  type TextStyler,
} from './terminal-style-policy.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';
import { renderReportJson } from './report-json.js';

export type WrappedReportFormat = 'terminal' | 'json';

export type RenderWrappedReportOptions = {
  useColor?: boolean;
  palette?: TerminalStylePalette;
};

export const wrappedReportFormats = [
  'terminal',
  'json',
] as const satisfies readonly WrappedReportFormat[];

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
// Block glyphs for monthly intensity levels 0..4.
const INTENSITY_GLYPHS = ['·', '▁', '▂', '▄', '█'];
const TOP_MODELS_HEADERS = ['#', 'Model', 'Tokens', 'Cost'] as const;
const TOP_SOURCES_HEADERS = ['#', 'Source', 'Tokens', 'Cost'] as const;
const TOP_ITEM_NAME_COLUMN = 1;

/** Gates a styler behind the color policy so `useColor: false` never emits ANSI. */
type Paint = (styler: TextStyler) => TextStyler;

function formatHours(activeMs: number): string {
  const hours = Math.round(activeMs / 3_600_000);

  if (hours === 0) {
    return activeMs > 0 ? '<1h' : '0h';
  }

  return `${formatInteger(hours)}h`;
}

function formatPeakHour(peakHour: WrappedRecap['peakHour']): string {
  return peakHour === undefined ? '-' : `${String(peakHour.hour).padStart(2, '0')}:00`;
}

function formatBusiestDay(busiestDay: WrappedRecap['busiestDay']): string {
  return busiestDay === undefined
    ? '-'
    : `${busiestDay.date} (${formatInteger(busiestDay.totalTokens)} tokens)`;
}

function renderStatLines(recap: WrappedRecap, paint: Paint, palette: TerminalStylePalette): string {
  const bold =
    (styler: TextStyler): TextStyler =>
    (text) =>
      palette.bold(styler(text));
  const totalSplitTokens = recap.weekdayTokens + recap.weekendTokens;
  const stats: { label: string; value: string; styler: TextStyler }[] = [
    { label: 'Tokens', value: formatInteger(recap.totalTokens), styler: bold(palette.cyan) },
    {
      label: 'Cost',
      value: formatApproxUsd(recap.costUsd, recap.costIncomplete),
      styler: bold(palette.green),
    },
    { label: 'Active days', value: formatInteger(recap.activeDays), styler: palette.white },
    {
      label: 'Longest streak',
      value: `${formatInteger(recap.longestStreak)} day${recap.longestStreak === 1 ? '' : 's'}`,
      styler: bold(palette.yellow),
    },
    { label: 'Hours', value: formatHours(recap.activeMs), styler: bold(palette.cyan) },
    { label: 'Peak hour', value: formatPeakHour(recap.peakHour), styler: palette.white },
  ];

  if (totalSplitTokens > 0) {
    stats.push({
      label: 'Weekday split',
      value: `${Math.round((100 * recap.weekdayTokens) / totalSplitTokens)}% weekday`,
      styler: palette.white,
    });
  }

  stats.push({
    label: 'Busiest day',
    value: formatBusiestDay(recap.busiestDay),
    styler: palette.white,
  });

  if (recap.estimatedCacheSavingsUsd !== undefined) {
    stats.push({
      label: 'Cache savings',
      value: formatApproxUsd(recap.estimatedCacheSavingsUsd, true),
      styler: bold(palette.green),
    });
  }

  stats.push(
    { label: 'Events', value: formatInteger(recap.eventCount), styler: palette.white },
    { label: 'Sessions', value: formatInteger(recap.sessionCount), styler: palette.white },
  );

  const labelWidth = stats.reduce((max, stat) => Math.max(max, stat.label.length), 0);

  return stats
    .map(
      (stat) =>
        `${paint(palette.dim)(stat.label.padEnd(labelWidth))}  ${paint(stat.styler)(stat.value)}`,
    )
    .join('\n');
}

function renderMonthlyStrip(
  recap: WrappedRecap,
  paint: Paint,
  palette: TerminalStylePalette,
): string {
  const boldGreen: TextStyler = (text) => palette.bold(palette.green(text));

  return recap.monthlyIntensity
    .map((month, index) => {
      const glyph = INTENSITY_GLYPHS[month.level] ?? '·';
      const label = MONTH_LABELS[index] ?? month.month;
      const glyphStyler =
        month.level === 0 ? palette.dim : month.level >= 3 ? boldGreen : palette.green;

      return `${paint(palette.dim)(label)} ${paint(glyphStyler)(glyph)}`;
    })
    .join('  ');
}

function toTopItemRows(items: readonly WrappedTopItem[]): string[][] {
  if (items.length === 0) {
    return [['-', '-', '-', '-']];
  }

  return items.map((item, index) => [
    String(index + 1),
    item.name,
    formatInteger(item.totalTokens),
    formatApproxUsd(item.costUsd, item.costIncomplete),
  ]);
}

function renderTopTable(headerCells: readonly string[], bodyRows: string[][]): string {
  const nameCells = [
    headerCells[TOP_ITEM_NAME_COLUMN],
    ...bodyRows.map((row) => row[TOP_ITEM_NAME_COLUMN]),
  ];
  const nameColumnWidth = nameCells.reduce((max, cell) => Math.max(max, visibleWidth(cell)), 0);
  const rowMetas: TableRowMeta[] = bodyRows.map(() => ({
    periodKey: 'wrapped',
    rowKind: 'detail',
  }));

  return renderUnicodeTable({
    headerCells,
    bodyRows,
    measureHeaderCells: headerCells,
    measureBodyRows: bodyRows,
    rowMetas,
    layout: 'compact',
    multilineColumnIndex: TOP_ITEM_NAME_COLUMN,
    multilineColumnWidth: nameColumnWidth,
  });
}

function renderWrappedTerminalReport(
  recap: WrappedRecap,
  options: RenderWrappedReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const palette = options.palette ?? defaultTerminalStylePalette;
  const paint: Paint = (styler) => (text) => (useColor ? styler(text) : text);

  return [
    renderReportHeader({ title: `Wrapped ${recap.year}`, useColor }),
    paint(palette.dim)(`${recap.from} to ${recap.to} (${recap.timezone})`),
    '',
    renderStatLines(recap, paint, palette),
    '',
    'Monthly activity',
    renderMonthlyStrip(recap, paint, palette),
    '',
    'Top models',
    renderTopTable(TOP_MODELS_HEADERS, toTopItemRows(recap.topModels)),
    '',
    'Top sources',
    renderTopTable(TOP_SOURCES_HEADERS, toTopItemRows(recap.topSources)),
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
    case 'terminal':
      return renderWrappedTerminalReport(recap, options);
  }
}
