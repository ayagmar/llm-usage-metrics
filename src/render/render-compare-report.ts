import { markdownTable } from 'markdown-table';

import type { CompareProjectRow, CompareReportData } from '../cli/build-compare-data.js';
import type {
  CompareMetricKey,
  CompareMetricRow,
  CompareSourceRow,
} from '../cli/usage-data-contracts.js';
import { formatAbbreviatedTokenCount, formatInteger, formatUsd } from './format-number.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { resolveTerminalWidth, truncateMiddle } from './table-text-layout.js';
import { createColorRoles, styleDeltaCell } from './terminal-style-policy.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';
import { renderReportJson } from './report-json.js';

export type CompareReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderCompareReportOptions = {
  useColor?: boolean;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
  /** Defaults to the stdout TTY width. */
  terminalWidth?: number;
};

/**
 * How a row's cells are written: colored or not, token counts abbreviated (a fitted
 * table), and the name cut to a width (the terminal; Markdown keeps names whole).
 */
type CellFormat = {
  useColor: boolean;
  abbreviate?: boolean;
  nameWidth?: number;
};

const percentFormatter = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const compareTableHeaders = ['Metric', 'Current', 'Baseline', 'Δ', 'Δ%'] as const;
const sourceTableHeaders = ['Source', 'Current', 'Baseline', 'Δ', 'Δ%'] as const;
const projectTableHeaders = ['Project', 'Current', 'Baseline', 'Δ', 'Δ%'] as const;

/** Project and source names longer than this are shortened in the middle in the terminal. */
const NAME_COLUMN_MAX_WIDTH = 28;
/** A table too wide for the terminal hides Baseline, then Δ%: Current and Δ tell the change. */
const HIDEABLE_COLUMNS = [2, 4];

const tokenMetricKeys: ReadonlySet<CompareMetricKey> = new Set([
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
]);

function formatDeltaInteger(
  value: number | undefined,
  options: { signed?: boolean; abbreviate?: boolean } = {},
): string {
  if (value === undefined) {
    return '-';
  }

  const format = options.abbreviate ? formatAbbreviatedTokenCount : formatInteger;

  if (!options.signed || value === 0) {
    return format(value);
  }

  const sign = value > 0 ? '+' : '-';
  return `${sign}${format(Math.abs(value))}`;
}

function formatDeltaUsd(
  value: number | undefined,
  options: { approximate?: boolean; signed?: boolean } = {},
): string {
  if (value === undefined) {
    return '-';
  }

  const sign = options.signed && value !== 0 ? (value > 0 ? '+' : '-') : '';
  const formatted = formatUsd(Math.abs(value));
  return `${sign}${options.approximate ? '~' : ''}${formatted}`;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) {
    return '-';
  }

  if (value === 0) {
    return '0%';
  }

  const sign = value > 0 ? '+' : '';
  return `${sign}${percentFormatter.format(value)}`;
}

/** Cost cells are money; a cost change is good when it falls. Token changes stay uncolored. */
function styleCostDelta(text: string, value: number | undefined, useColor: boolean): string {
  return styleDeltaCell(value, text, useColor, { lowerIsBetter: true });
}

function toNameCell(name: string, format: CellFormat): string {
  return format.nameWidth === undefined ? name : truncateMiddle(name, format.nameWidth);
}

function formatMetricValue(
  row: CompareMetricRow,
  value: number | undefined,
  approximate: boolean | undefined,
  format: CellFormat,
): string {
  if (row.valueType === 'usd') {
    return createColorRoles(format.useColor).money(formatDeltaUsd(value, { approximate }));
  }

  return formatDeltaInteger(value, {
    abbreviate: format.abbreviate && tokenMetricKeys.has(row.key),
  });
}

function toMetricTableRow(row: CompareMetricRow, format: CellFormat): string[] {
  const deltaRatio = formatPercent(row.deltaRatio);
  const cells = [
    row.label,
    formatMetricValue(row, row.current, row.currentCostIncomplete, format),
    formatMetricValue(row, row.baseline, row.baselineCostIncomplete, format),
  ];

  if (row.valueType === 'usd') {
    const delta = formatDeltaUsd(row.delta, {
      approximate: row.deltaCostIncomplete,
      signed: true,
    });

    return [
      ...cells,
      styleCostDelta(delta, row.delta, format.useColor),
      styleCostDelta(deltaRatio, row.deltaRatio, format.useColor),
    ];
  }

  const delta = formatDeltaInteger(row.delta, {
    signed: true,
    abbreviate: format.abbreviate && tokenMetricKeys.has(row.key),
  });

  return [...cells, delta, deltaRatio];
}

function toSourceTableRow(row: CompareSourceRow, format: CellFormat): string[] {
  const name = createColorRoles(format.useColor).source(row.source)(toNameCell(row.source, format));
  return toCostTableRow(name, row, format);
}

function toProjectTableRow(row: CompareProjectRow, format: CellFormat): string[] {
  return toCostTableRow(toNameCell(row.project, format), row, format);
}

function toCostTableRow(
  name: string,
  row: Omit<CompareSourceRow, 'source'>,
  format: CellFormat,
): string[] {
  const { money } = createColorRoles(format.useColor);
  const delta = formatDeltaUsd(row.delta.costUsd, {
    approximate: row.delta.costIncomplete,
    signed: true,
  });
  const deltaRatio = formatPercent(row.deltaRatio.costUsd);

  return [
    name,
    money(formatDeltaUsd(row.current.costUsd, { approximate: row.current.costIncomplete })),
    money(formatDeltaUsd(row.baseline.costUsd, { approximate: row.baseline.costIncomplete })),
    styleCostDelta(delta, row.delta.costUsd, format.useColor),
    styleCostDelta(deltaRatio, row.deltaRatio.costUsd, format.useColor),
  ];
}

function createRowMetas(rowCount: number): TableRowMeta[] {
  return Array.from({ length: rowCount }, () => ({
    periodKey: 'compare',
    rowKind: 'detail' as const,
  }));
}

/**
 * A boxed table fitted to the terminal: token counts abbreviated, then Baseline and Δ%
 * hidden, then listed rows. Names are capped at `NAME_COLUMN_MAX_WIDTH` at every step.
 */
function renderTerminalTable<Row>(options: {
  headerCells: readonly string[];
  rows: readonly Row[];
  toCells: (row: Row, format: CellFormat) => string[];
  useColor: boolean;
  terminalWidth: number | undefined;
}): string {
  const { header } = createColorRoles(options.useColor);
  const cells = (format: Omit<CellFormat, 'nameWidth'>) =>
    options.rows.map((row) =>
      options.toCells(row, { ...format, nameWidth: NAME_COLUMN_MAX_WIDTH }),
    );

  return renderUnicodeTable({
    headerCells: options.headerCells.map((cell) => header(cell)),
    bodyRows: cells({ useColor: options.useColor }),
    measureHeaderCells: options.headerCells,
    measureBodyRows: cells({ useColor: false }),
    rowMetas: createRowMetas(options.rows.length),
    columnKinds: options.headerCells.map((_, index) => (index === 0 ? 'text' : 'measure')),
    multilineColumnIndex: 0,
    terminalWidth: options.terminalWidth,
    fit: {
      abbreviatedBodyRows: cells({ useColor: options.useColor, abbreviate: true }),
      abbreviatedMeasureBodyRows: cells({ useColor: false, abbreviate: true }),
      hideableColumns: HIDEABLE_COLUMNS,
    },
  });
}

function hasNoUsage(compareData: CompareReportData): boolean {
  return compareData.current.totals.events === 0 && compareData.baseline.totals.events === 0;
}

function renderTerminalCompareReport(
  compareData: CompareReportData,
  options: RenderCompareReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const terminalWidth = resolveTerminalWidth(options.terminalWidth);
  const lines: string[] = [];

  lines.push(
    renderReportHeader({
      title: `Compare: ${compareData.current.window.label} vs ${compareData.baseline.window.label}`,
      useColor,
      terminalWidth,
    }),
  );
  lines.push('');

  if (hasNoUsage(compareData)) {
    lines.push(formatNoUsageMessage(options.filtered ?? false));
    return lines.join('\n');
  }

  lines.push(
    renderTerminalTable({
      headerCells: compareTableHeaders,
      rows: compareData.totals,
      toCells: toMetricTableRow,
      useColor,
      terminalWidth,
    }),
  );
  lines.push('');
  lines.push('By source (cost)');
  lines.push(
    renderTerminalTable({
      headerCells: sourceTableHeaders,
      rows: compareData.sources,
      toCells: toSourceTableRow,
      useColor,
      terminalWidth,
    }),
  );

  if (compareData.projects) {
    lines.push('');
    lines.push('By project (cost)');
    lines.push(
      renderTerminalTable({
        headerCells: projectTableHeaders,
        rows: compareData.projects,
        toCells: toProjectTableRow,
        useColor,
        terminalWidth,
      }),
    );
  }

  return lines.join('\n');
}

function renderMarkdownRows(headers: readonly string[], rows: string[][]): string {
  return markdownTable(
    [[...headers], ...rows].map((row) => row.map((cell) => toMarkdownSafeCell(cell))),
    { align: ['l', 'r', 'r', 'r', 'r'] },
  );
}

function renderMarkdownCompareReport(compareData: CompareReportData): string {
  const projectSection = compareData.projects
    ? [
        '',
        '### By project (cost)',
        '',
        renderMarkdownRows(
          projectTableHeaders,
          compareData.projects.map((row) => toProjectTableRow(row, { useColor: false })),
        ),
      ]
    : [];

  return [
    `### Compare: ${toMarkdownSafeCell(compareData.current.window.label)} vs ${toMarkdownSafeCell(
      compareData.baseline.window.label,
    )}`,
    '',
    renderMarkdownRows(
      compareTableHeaders,
      compareData.totals.map((row) => toMetricTableRow(row, { useColor: false })),
    ),
    '',
    '### By source (cost)',
    '',
    renderMarkdownRows(
      sourceTableHeaders,
      compareData.sources.map((row) => toSourceTableRow(row, { useColor: false })),
    ),
    ...projectSection,
  ].join('\n');
}

export function renderCompareReport(
  compareData: CompareReportData,
  format: CompareReportFormat,
  options: RenderCompareReportOptions = {},
): string {
  switch (format) {
    case 'json':
      return renderReportJson('compare', {
        current: compareData.current,
        baseline: compareData.baseline,
        totals: compareData.totals,
        sources: compareData.sources,
        projects: compareData.projects,
      });
    case 'markdown':
      return renderMarkdownCompareReport(compareData);
    case 'terminal':
      return renderTerminalCompareReport(compareData, options);
  }
}
