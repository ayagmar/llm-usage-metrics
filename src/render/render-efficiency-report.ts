import { markdownTable } from 'markdown-table';
import pc from 'picocolors';

import type { EfficiencyDataResult } from '../cli/usage-data-contracts.js';
import type { EfficiencyRow } from '../efficiency/efficiency-row.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { efficiencyTableHeaders, toEfficiencyTableCells } from './efficiency-row-cells.js';
import { resolveTtyColumns, splitCellLines, visibleWidth } from './table-text-layout.js';
import { styleDeltaCell } from './terminal-style-policy.js';
import { selectColumns, type UsageTokenFormat } from './row-cells.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';
import { renderReportJson } from './report-json.js';

export type EfficiencyReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderEfficiencyReportOptions = {
  granularity: ReportGranularity;
  useColor?: boolean;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
};

const periodColumnIndex = 0;
const commitsColumnIndex = 1;
const linesAddedColumnIndex = 2;
const linesDeletedColumnIndex = 3;
const linesChangedColumnIndex = 4;
const inputColumnIndex = 5;
const outputColumnIndex = 6;
const reasoningColumnIndex = 7;
const cacheReadColumnIndex = 8;
const cacheWriteColumnIndex = 9;
const costColumnIndex = 11;
const usdPerCommitColumnIndex = 12;
const usdPer1kLinesChangedColumnIndex = 13;
const commitsPerUsdColumnIndex = 15;

type EfficiencyFitStep = {
  tokenFormat: UsageTokenFormat;
  hiddenColumnIndexes: readonly number[];
};

/** Ordered from most to least detail; the list layout is the last resort. */
const efficiencyFitSteps: readonly EfficiencyFitStep[] = [
  { tokenFormat: 'full', hiddenColumnIndexes: [] },
  { tokenFormat: 'abbreviated', hiddenColumnIndexes: [] },
  {
    tokenFormat: 'abbreviated',
    hiddenColumnIndexes: [
      inputColumnIndex,
      outputColumnIndex,
      reasoningColumnIndex,
      cacheWriteColumnIndex,
    ],
  },
  {
    tokenFormat: 'abbreviated',
    hiddenColumnIndexes: [
      linesAddedColumnIndex,
      linesDeletedColumnIndex,
      inputColumnIndex,
      outputColumnIndex,
      reasoningColumnIndex,
      cacheReadColumnIndex,
      cacheWriteColumnIndex,
      commitsPerUsdColumnIndex,
    ],
  },
];

export type RenderedEfficiencyReport = {
  output: string;
  /** stderr notes, such as what fitting the table to the terminal left out. */
  notes: string[];
};

type FittedEfficiencyTableCells = {
  headerCells: string[];
  bodyRows: string[][];
  widths: number[];
  stackedWidth?: number;
};

function getReportTitle(granularity: ReportGranularity): string {
  switch (granularity) {
    case 'daily':
      return 'Daily Efficiency Report';
    case 'weekly':
      return 'Weekly Efficiency Report';
    case 'monthly':
      return 'Monthly Efficiency Report';
  }
}

function toTableRowMeta(row: EfficiencyRow): TableRowMeta {
  return {
    periodKey: row.periodKey,
    periodGroup: row.rowType === 'grand_total' ? 'summary' : 'normal',
    rowKind:
      row.rowType === 'grand_total' ? 'total' : row.rowType === 'period' ? 'combined' : 'detail',
  };
}

function measureRenderedTableWidth(columnWidths: number[]): number {
  if (columnWidths.length === 0) {
    return 0;
  }

  return columnWidths.reduce((sum, width) => sum + width, 0) + columnWidths.length * 3 + 1;
}

function computeColumnWidths(
  headerCells: readonly string[],
  bodyRows: readonly string[][],
): number[] {
  const columnCount = Math.max(headerCells.length, ...bodyRows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, () => 0);

  const measureRow = (row: readonly string[]) => {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      for (const line of splitCellLines(row[columnIndex] ?? '')) {
        widths[columnIndex] = Math.max(widths[columnIndex], visibleWidth(line));
      }
    }
  };

  measureRow(headerCells);

  for (const row of bodyRows) {
    measureRow(row);
  }

  return widths;
}

/** Header pieces that may start a new line: words, and the parts after a `/`. */
function splitHeaderPieces(header: string): string[] {
  return header.split(' ').flatMap((word) => word.split(/(?<=\/)/u));
}

function wrapHeader(header: string, width: number): string {
  const lines: string[] = [];

  for (const piece of splitHeaderPieces(header)) {
    const lastLine = lines.at(-1);
    const separator = lastLine === undefined || lastLine.endsWith('/') ? '' : ' ';

    if (lastLine !== undefined && visibleWidth(lastLine + separator + piece) <= width) {
      lines[lines.length - 1] = lastLine + separator + piece;
    } else {
      lines.push(piece);
    }
  }

  return lines.join('\n');
}

/** Narrowest width for a column: values never wrap, headers wrap only between pieces. */
function computeMinimumColumnWidths(
  headerCells: readonly string[],
  bodyRows: readonly string[][],
): number[] {
  const headerPieceWidths = headerCells.map((header) =>
    splitHeaderPieces(header).reduce(
      (maxWidth, piece) => Math.max(maxWidth, visibleWidth(piece)),
      0,
    ),
  );

  return computeColumnWidths([], bodyRows).map((bodyWidth, columnIndex) =>
    Math.max(bodyWidth, headerPieceWidths[columnIndex] ?? 0),
  );
}

/**
 * Wraps headers to fit the terminal. When even the narrowest columns are too wide,
 * returns the cells unchanged with `stackedWidth`, so rows are listed instead of boxed.
 */
function fitTableCellsToTerminal(
  headerCells: readonly string[],
  bodyRows: readonly string[][],
): FittedEfficiencyTableCells {
  const naturalWidths = computeColumnWidths(headerCells, bodyRows);
  const terminalWidth = resolveTtyColumns(process.stdout);
  const natural = {
    headerCells: [...headerCells],
    bodyRows: bodyRows.map((row) => [...row]),
    widths: naturalWidths,
  };

  if (terminalWidth === undefined || measureRenderedTableWidth(naturalWidths) <= terminalWidth) {
    return natural;
  }

  const minimumWidths = computeMinimumColumnWidths(headerCells, bodyRows);

  if (measureRenderedTableWidth(minimumWidths) > terminalWidth) {
    return { ...natural, stackedWidth: terminalWidth };
  }

  const constrainedWidths = [...naturalWidths];
  let overflowColumns = measureRenderedTableWidth(constrainedWidths) - terminalWidth;

  while (overflowColumns > 0) {
    // Shrink the column with the most room to spare above its minimum.
    let shrinkIndex = 0;

    for (let columnIndex = 1; columnIndex < constrainedWidths.length; columnIndex += 1) {
      if (
        constrainedWidths[columnIndex] - minimumWidths[columnIndex] >
        constrainedWidths[shrinkIndex] - minimumWidths[shrinkIndex]
      ) {
        shrinkIndex = columnIndex;
      }
    }

    const reduction = Math.min(
      overflowColumns,
      constrainedWidths[shrinkIndex] - minimumWidths[shrinkIndex],
    );
    constrainedWidths[shrinkIndex] -= reduction;
    overflowColumns -= reduction;
  }

  return {
    headerCells: headerCells.map((header, columnIndex) =>
      wrapHeader(header, constrainedWidths[columnIndex]),
    ),
    bodyRows: natural.bodyRows,
    widths: constrainedWidths,
  };
}

function styleEfficiencyTerminalRows(
  rows: EfficiencyRow[],
  bodyRows: string[][],
  options: { useColor: boolean },
): string[][] {
  return bodyRows.map((cells, rowIndex) => {
    if (!options.useColor) {
      return [...cells];
    }

    const row = rows[rowIndex];
    const styledCells = [...cells];
    const periodCell = styledCells[periodColumnIndex];

    if (row.rowType === 'period_source') {
      styledCells[periodColumnIndex] = pc.dim(periodCell);

      const costValue = row.costUsd;
      if (costValue !== undefined && costValue > 0) {
        styledCells[costColumnIndex] = pc.yellow(styledCells[costColumnIndex]);
      }

      return styledCells;
    }

    styledCells[periodColumnIndex] =
      row.rowType === 'grand_total' ? pc.bold(pc.cyan(periodCell)) : pc.bold(periodCell);
    styledCells[commitsColumnIndex] = pc.bold(styledCells[commitsColumnIndex]);
    styledCells[linesAddedColumnIndex] = styleDeltaCell(
      row.linesAdded,
      styledCells[linesAddedColumnIndex],
      options.useColor,
    );
    styledCells[linesDeletedColumnIndex] = styleDeltaCell(
      row.linesDeleted * -1,
      styledCells[linesDeletedColumnIndex],
      options.useColor,
    );
    styledCells[linesChangedColumnIndex] = styleDeltaCell(
      row.linesChanged,
      styledCells[linesChangedColumnIndex],
      options.useColor,
    );

    const costValue = row.costUsd;
    if (costValue !== undefined && costValue > 0) {
      styledCells[costColumnIndex] = pc.yellow(styledCells[costColumnIndex]);
    }

    const usdPerCommitValue = row.usdPerCommit;
    if (usdPerCommitValue !== undefined && usdPerCommitValue > 0) {
      styledCells[usdPerCommitColumnIndex] = pc.yellow(styledCells[usdPerCommitColumnIndex]);
    }

    const usdPer1kLinesChangedValue = row.usdPer1kLinesChanged;
    if (usdPer1kLinesChangedValue !== undefined && usdPer1kLinesChangedValue > 0) {
      styledCells[usdPer1kLinesChangedColumnIndex] = pc.yellow(
        styledCells[usdPer1kLinesChangedColumnIndex],
      );
    }

    const commitsPerUsdValue = row.commitsPerUsd;
    if (commitsPerUsdValue !== undefined && commitsPerUsdValue > 0) {
      styledCells[commitsPerUsdColumnIndex] = pc.green(styledCells[commitsPerUsdColumnIndex]);
    }

    return styledCells;
  });
}

function fitEfficiencyStep(
  rows: EfficiencyRow[],
  step: EfficiencyFitStep,
  options: { useColor: boolean },
): FittedEfficiencyTableCells {
  const visibleColumnIndexes = efficiencyTableHeaders
    .map((_, columnIndex) => columnIndex)
    .filter((columnIndex) => !step.hiddenColumnIndexes.includes(columnIndex));
  const styledRows = styleEfficiencyTerminalRows(
    rows,
    toEfficiencyTableCells(rows, step.tokenFormat),
    options,
  );

  return fitTableCellsToTerminal(
    selectColumns(Array.from(efficiencyTableHeaders), visibleColumnIndexes),
    styledRows.map((row) => selectColumns(row, visibleColumnIndexes)),
  );
}

function describeEfficiencyFit(step: EfficiencyFitStep, stacked: boolean): string | undefined {
  if (stacked) {
    return 'Listed rows instead of a table to fit the terminal. Widen the terminal to see the table.';
  }

  const changes: string[] = [];

  if (step.tokenFormat === 'abbreviated') {
    changes.push('abbreviated token counts');
  }

  const hiddenHeaders = step.hiddenColumnIndexes.map(
    (columnIndex) => efficiencyTableHeaders[columnIndex],
  );

  if (hiddenHeaders.length > 0) {
    changes.push(`hid ${hiddenHeaders.slice(0, -1).join(', ')} and ${hiddenHeaders.at(-1) ?? ''}`);
  }

  return changes.length > 0
    ? `Fitted the table to the terminal: ${changes.join(', ')}. Widen the terminal or use --json for full detail.`
    : undefined;
}

function renderTerminalEfficiencyTable(
  rows: EfficiencyRow[],
  options: { useColor: boolean },
): RenderedEfficiencyReport {
  const rowMetas = rows.map((row) => toTableRowMeta(row));
  let fittedStep = efficiencyFitSteps[0];
  let fittedCells = fitEfficiencyStep(rows, fittedStep, options);

  for (const step of efficiencyFitSteps.slice(1)) {
    if (fittedCells.stackedWidth === undefined) {
      break;
    }

    const candidate = fitEfficiencyStep(rows, step, options);

    if (candidate.stackedWidth === undefined) {
      fittedStep = step;
      fittedCells = candidate;
    }
  }

  // Listed rows have room for every column at full precision.
  const note = describeEfficiencyFit(fittedStep, fittedCells.stackedWidth !== undefined);
  const output = renderUnicodeTable({
    headerCells: fittedCells.headerCells,
    bodyRows: fittedCells.bodyRows,
    measureHeaderCells: fittedCells.headerCells,
    measureBodyRows: fittedCells.bodyRows,
    rowMetas,
    columnKinds: fittedCells.headerCells.map((_, index) =>
      index === periodColumnIndex ? 'text' : 'measure',
    ),
    multilineColumnIndex: periodColumnIndex,
    multilineColumnWidth:
      fittedCells.widths[periodColumnIndex] ?? efficiencyTableHeaders[periodColumnIndex].length,
    terminalWidth: fittedCells.stackedWidth,
  });

  return { output, notes: note ? [note] : [] };
}

function renderMarkdownEfficiencyTable(rows: EfficiencyRow[]): string {
  const bodyRows = toEfficiencyTableCells(rows).map((row) =>
    row.map((cell) => toMarkdownSafeCell(cell)),
  );
  const tableRows = [Array.from(efficiencyTableHeaders), ...bodyRows];
  const alignment = efficiencyTableHeaders.map((_, index) => (index === 0 ? 'l' : 'r')) as (
    'l' | 'r'
  )[];

  return markdownTable(tableRows, {
    align: alignment,
  });
}

/** Only the ALL row: no period had both commits and usage. */
function hasNoEfficiencyPeriods(efficiencyData: EfficiencyDataResult): boolean {
  return efficiencyData.rows.every((row) => row.rowType === 'grand_total');
}

function formatNoEfficiencyUsageMessage(options: RenderEfficiencyReportOptions): string {
  return formatNoUsageMessage(options.filtered ?? false, 'in periods with commits');
}

function renderTerminalEfficiencyReport(
  efficiencyData: EfficiencyDataResult,
  options: RenderEfficiencyReportOptions,
): RenderedEfficiencyReport {
  const outputLines: string[] = [];
  const useColor = options.useColor ?? shouldUseColorByDefault();

  outputLines.push(
    renderReportHeader({
      title: getReportTitle(options.granularity),
      useColor,
    }),
  );

  if (hasNoEfficiencyPeriods(efficiencyData)) {
    outputLines.push('', formatNoEfficiencyUsageMessage(options));
    return { output: outputLines.join('\n'), notes: [] };
  }

  const table = renderTerminalEfficiencyTable(efficiencyData.rows, { useColor });
  outputLines.push('', table.output);

  return { output: outputLines.join('\n'), notes: table.notes };
}

export function renderEfficiencyReportWithNotes(
  efficiencyData: EfficiencyDataResult,
  format: EfficiencyReportFormat,
  options: RenderEfficiencyReportOptions,
): RenderedEfficiencyReport {
  switch (format) {
    case 'json':
      return {
        output: renderReportJson('efficiency', {
          grouping: efficiencyData.grouping,
          rows: efficiencyData.rows,
        }),
        notes: [],
      };
    case 'markdown':
      return {
        output: hasNoEfficiencyPeriods(efficiencyData)
          ? formatNoEfficiencyUsageMessage(options)
          : renderMarkdownEfficiencyTable(efficiencyData.rows),
        notes: [],
      };
    case 'terminal':
      return renderTerminalEfficiencyReport(efficiencyData, options);
  }
}

export function renderEfficiencyReport(
  efficiencyData: EfficiencyDataResult,
  format: EfficiencyReportFormat,
  options: RenderEfficiencyReportOptions,
): string {
  return renderEfficiencyReportWithNotes(efficiencyData, format, options).output;
}
