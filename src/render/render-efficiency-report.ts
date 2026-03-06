import { markdownTable } from 'markdown-table';
import pc from 'picocolors';

import type { EfficiencyDataResult } from '../cli/usage-data-contracts.js';
import type { EfficiencyRow } from '../efficiency/efficiency-row.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { renderReportHeader } from './report-header.js';
import { efficiencyTableHeaders, toEfficiencyTableCells } from './efficiency-row-cells.js';
import {
  resolveTtyColumns,
  splitCellLines,
  visibleWidth,
  wrapTableColumn,
} from './table-text-layout.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';

export type EfficiencyReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderEfficiencyReportOptions = {
  granularity: ReportGranularity;
  useColor?: boolean;
};

const periodColumnIndex = 0;
const minimumEfficiencyColumnWidth = 1;
const commitsColumnIndex = 1;
const linesAddedColumnIndex = 2;
const linesDeletedColumnIndex = 3;
const linesChangedColumnIndex = 4;
const costColumnIndex = 11;
const usdPerCommitColumnIndex = 12;
const usdPer1kLinesChangedColumnIndex = 13;
const commitsPerUsdColumnIndex = 16;

type FittedEfficiencyTableCells = {
  headerCells: string[];
  bodyRows: string[][];
  widths: number[];
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
    rowKind: row.rowType === 'grand_total' ? 'total' : 'detail',
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
  const columnCount = Math.max(
    headerCells.length,
    ...bodyRows.map((row) => row.length),
    efficiencyTableHeaders.length,
  );
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

function resolveWrappedCells(
  headerCells: readonly string[],
  bodyRows: readonly string[][],
  widths: readonly number[],
): { wrappedHeaderCells: string[]; wrappedBodyRows: string[][] } {
  let wrappedHeaderCells = [...headerCells];
  let wrappedBodyRows = bodyRows.map((row) => [...row]);

  for (let columnIndex = 0; columnIndex < widths.length; columnIndex += 1) {
    const columnWidth = widths[columnIndex] ?? 0;

    if (columnWidth <= 0) {
      continue;
    }

    wrappedHeaderCells =
      wrapTableColumn([wrappedHeaderCells], {
        columnIndex,
        width: columnWidth,
      })[0] ?? [];
    wrappedBodyRows = wrapTableColumn(wrappedBodyRows, {
      columnIndex,
      width: columnWidth,
    });
  }

  return {
    wrappedHeaderCells,
    wrappedBodyRows,
  };
}

function fitTableCellsToTerminal(
  headerCells: readonly string[],
  bodyRows: readonly string[][],
): FittedEfficiencyTableCells {
  const naturalWidths = computeColumnWidths(headerCells, bodyRows);
  const terminalWidth = resolveTtyColumns(process.stdout as { isTTY?: unknown; columns?: unknown });

  if (terminalWidth === undefined || measureRenderedTableWidth(naturalWidths) <= terminalWidth) {
    return {
      headerCells: [...headerCells],
      bodyRows: bodyRows.map((row) => [...row]),
      widths: naturalWidths,
    };
  }

  const constrainedWidths = [...naturalWidths];
  let renderedTableWidth = measureRenderedTableWidth(constrainedWidths);

  while (
    renderedTableWidth > terminalWidth &&
    constrainedWidths.some((width) => width > minimumEfficiencyColumnWidth)
  ) {
    let widestIndex = -1;
    let widestWidth = -1;

    for (let columnIndex = 0; columnIndex < constrainedWidths.length; columnIndex += 1) {
      const columnWidth = constrainedWidths[columnIndex];

      if (columnWidth <= minimumEfficiencyColumnWidth || columnWidth <= widestWidth) {
        continue;
      }

      widestIndex = columnIndex;
      widestWidth = columnWidth;
    }

    if (widestIndex === -1) {
      break;
    }

    const overflowColumns = renderedTableWidth - terminalWidth;
    const maxReducibleWidth = widestWidth - minimumEfficiencyColumnWidth;
    const reduction = Math.min(overflowColumns, maxReducibleWidth);

    if (reduction <= 0) {
      break;
    }

    constrainedWidths[widestIndex] -= reduction;
    renderedTableWidth -= reduction;
  }

  const { wrappedHeaderCells, wrappedBodyRows } = resolveWrappedCells(
    headerCells,
    bodyRows,
    constrainedWidths,
  );

  return {
    headerCells: wrappedHeaderCells,
    bodyRows: wrappedBodyRows,
    widths: constrainedWidths,
  };
}

function styleDeltaCell(
  value: number,
  formattedValue: string,
  options: { useColor: boolean },
): string {
  if (!options.useColor) {
    return formattedValue;
  }

  if (value > 0) {
    return pc.green(formattedValue);
  }

  if (value < 0) {
    return pc.red(formattedValue);
  }

  return pc.dim(formattedValue);
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

    styledCells[periodColumnIndex] =
      row.rowType === 'grand_total' ? pc.bold(pc.cyan(periodCell)) : pc.bold(periodCell);
    styledCells[commitsColumnIndex] = pc.bold(styledCells[commitsColumnIndex]);
    styledCells[linesAddedColumnIndex] = styleDeltaCell(
      row.linesAdded,
      styledCells[linesAddedColumnIndex],
      options,
    );
    styledCells[linesDeletedColumnIndex] = styleDeltaCell(
      row.linesDeleted * -1,
      styledCells[linesDeletedColumnIndex],
      options,
    );
    styledCells[linesChangedColumnIndex] = styleDeltaCell(
      row.linesChanged,
      styledCells[linesChangedColumnIndex],
      options,
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

function renderTerminalEfficiencyTable(
  rows: EfficiencyRow[],
  options: { useColor: boolean },
): string {
  const headerCells = Array.from(efficiencyTableHeaders);
  const bodyRows = styleEfficiencyTerminalRows(rows, toEfficiencyTableCells(rows), options);
  const rowMetas = rows.map((row) => toTableRowMeta(row));
  const fittedCells = fitTableCellsToTerminal(headerCells, bodyRows);

  return renderUnicodeTable({
    headerCells: fittedCells.headerCells,
    bodyRows: fittedCells.bodyRows,
    measureHeaderCells: fittedCells.headerCells,
    measureBodyRows: fittedCells.bodyRows,
    rowMetas,
    layout: 'compact',
    multilineColumnIndex: periodColumnIndex,
    multilineColumnWidth:
      fittedCells.widths[periodColumnIndex] ?? efficiencyTableHeaders[periodColumnIndex].length,
  });
}

function toMarkdownSafeCell(value: string): string {
  return value.replace(/\r?\n/gu, '<br>');
}

function renderMarkdownEfficiencyTable(rows: EfficiencyRow[]): string {
  const bodyRows = toEfficiencyTableCells(rows).map((row) =>
    row.map((cell) => toMarkdownSafeCell(cell)),
  );
  const tableRows = [Array.from(efficiencyTableHeaders), ...bodyRows];
  const alignment = efficiencyTableHeaders.map((_, index) => (index === 0 ? 'l' : 'r')) as (
    | 'l'
    | 'r'
  )[];

  return markdownTable(tableRows, {
    align: alignment,
  });
}

function renderTerminalEfficiencyReport(
  efficiencyData: EfficiencyDataResult,
  options: RenderEfficiencyReportOptions,
): string {
  const outputLines: string[] = [];
  const useColor = options.useColor ?? shouldUseColorByDefault();

  outputLines.push(
    renderReportHeader({
      title: getReportTitle(options.granularity),
      useColor,
    }),
  );

  outputLines.push('');
  outputLines.push(renderTerminalEfficiencyTable(efficiencyData.rows, { useColor }));

  return outputLines.join('\n');
}

export function renderEfficiencyReport(
  efficiencyData: EfficiencyDataResult,
  format: EfficiencyReportFormat,
  options: RenderEfficiencyReportOptions,
): string {
  switch (format) {
    case 'json':
      return JSON.stringify(efficiencyData.rows, null, 2);
    case 'markdown':
      return renderMarkdownEfficiencyTable(efficiencyData.rows);
    case 'terminal':
      return renderTerminalEfficiencyReport(efficiencyData, options);
  }
}
