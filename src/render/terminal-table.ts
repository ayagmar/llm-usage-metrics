import pc from 'picocolors';

import type { UsageReportRow } from '../domain/usage-report-row.js';
import { colorizeUsageBodyRows } from './terminal-style-policy.js';
import { toUsageTableCells, type UsageTableLayout, usageTableHeaders } from './row-cells.js';
import {
  resolveTtyColumns,
  splitCellLines,
  visibleWidth,
  wrapTableColumn,
} from './table-text-layout.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';

const modelsColumnIndex = 2;
const defaultModelsColumnWidth = 32;
const minimumModelsColumnWidth = 12;
const compactModelsColumnGap = 2;

type TerminalRenderOptions = {
  useColor?: boolean;
  tableLayout?: UsageTableLayout;
  terminalWidth?: number;
};

export function shouldUseColorByDefault(): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }

  if (process.env.FORCE_COLOR !== undefined) {
    return process.env.FORCE_COLOR !== '0';
  }

  const stdoutIsTTY = (process.stdout as { isTTY: unknown }).isTTY;
  return stdoutIsTTY === true;
}

function colorizeHeader(useColor: boolean): string[] {
  const headerCells = Array.from(usageTableHeaders);

  if (!useColor) {
    return headerCells;
  }

  return headerCells.map((header, index) => {
    switch (index) {
      case 1:
        return pc.bold(pc.cyan(header));
      case 2:
        return pc.bold(pc.magenta(header));
      case 3:
      case 6:
        return pc.bold(pc.blue(header));
      case 4:
      case 7:
        return pc.bold(pc.cyan(header));
      case 5:
        return pc.bold(pc.magenta(header));
      case 8:
        return pc.bold(pc.green(header));
      case 9:
        return pc.bold(pc.yellow(header));
      default:
        return pc.bold(pc.white(header));
    }
  });
}

function isValidTerminalWidth(width: unknown): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0;
}

function resolveTerminalWidth(override: number | undefined): number | undefined {
  if (isValidTerminalWidth(override)) {
    return Math.floor(override);
  }

  return resolveTtyColumns(process.stdout as { isTTY?: unknown; columns?: unknown });
}

function measureTableWidth(tableOutput: string): number {
  return tableOutput
    .trimEnd()
    .split('\n')
    .reduce((maxWidth, line) => Math.max(maxWidth, visibleWidth(line)), 0);
}

function padVisibleEnd(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function formatCompactModelsCell(value: string, width: number): string {
  const modelLines = splitCellLines(value);

  if (modelLines.length < 2) {
    return value;
  }

  const longestLineWidth = modelLines.reduce(
    (maxWidth, line) => Math.max(maxWidth, visibleWidth(line)),
    0,
  );
  const maxColumnCount = Math.floor(
    (width + compactModelsColumnGap) / (longestLineWidth + compactModelsColumnGap),
  );

  if (maxColumnCount <= 1) {
    return value;
  }

  const columnCount = Math.min(modelLines.length, maxColumnCount);
  const rowCount = Math.ceil(modelLines.length / columnCount);
  const compactLines: string[] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const rowStart = rowIndex * columnCount;
    const cells = modelLines.slice(rowStart, rowStart + columnCount);

    compactLines.push(
      cells
        .map((cell, columnIndex) =>
          columnIndex === cells.length - 1 ? cell : padVisibleEnd(cell, longestLineWidth),
        )
        .join(' '.repeat(compactModelsColumnGap)),
    );
  }

  return compactLines.join('\n');
}

function layoutModelsColumn(
  bodyRows: string[][],
  tableLayout: UsageTableLayout,
  modelsColumnWidth: number,
): string[][] {
  if (tableLayout !== 'compact' || modelsColumnWidth <= defaultModelsColumnWidth) {
    return bodyRows.map((row) => [...row]);
  }

  return bodyRows.map((row) => {
    const nextRow = [...row];
    nextRow[modelsColumnIndex] = formatCompactModelsCell(
      nextRow[modelsColumnIndex],
      modelsColumnWidth,
    );

    return nextRow;
  });
}

function prepareWrappedBodyRows(
  bodyRows: string[][],
  tableLayout: UsageTableLayout,
  modelsColumnWidth: number,
): string[][] {
  const laidOutRows = layoutModelsColumn(bodyRows, tableLayout, modelsColumnWidth);

  return wrapTableColumn(laidOutRows, {
    columnIndex: modelsColumnIndex,
    width: modelsColumnWidth,
  });
}

function measureCompactBodyHeight(bodyRows: string[][], modelsColumnWidth: number): number {
  return prepareWrappedBodyRows(bodyRows, 'compact', modelsColumnWidth).reduce(
    (totalHeight, row) => totalHeight + splitCellLines(row[modelsColumnIndex] ?? '').length,
    0,
  );
}

function resolveExpandedModelsColumnWidth(
  bodyRows: string[][],
  tableLayout: UsageTableLayout,
  currentWidth: number,
  maximumWidth: number,
): number {
  if (maximumWidth <= currentWidth) {
    return currentWidth;
  }

  if (tableLayout === 'per_model_columns') {
    const longestModelLineWidth = bodyRows.reduce((maxWidth, row) => {
      const cellMaxWidth = splitCellLines(row[modelsColumnIndex] ?? '').reduce(
        (lineMaxWidth, line) => Math.max(lineMaxWidth, visibleWidth(line)),
        0,
      );

      return Math.max(maxWidth, cellMaxWidth);
    }, currentWidth);
    const preferredWidth = Math.max(
      currentWidth,
      defaultModelsColumnWidth + 16,
      longestModelLineWidth,
    );

    return Math.min(maximumWidth, preferredWidth);
  }

  const candidateWidths = new Set<number>([currentWidth]);

  for (const row of bodyRows) {
    const modelLines = splitCellLines(row[modelsColumnIndex] ?? '');
    const longestLineWidth = modelLines.reduce(
      (maxLineWidth, line) => Math.max(maxLineWidth, visibleWidth(line)),
      0,
    );

    if (longestLineWidth > currentWidth && longestLineWidth <= maximumWidth) {
      candidateWidths.add(longestLineWidth);
    }

    if (modelLines.length < 2) {
      continue;
    }

    for (let columnCount = 2; columnCount <= modelLines.length; columnCount += 1) {
      const candidateWidth =
        columnCount * longestLineWidth + (columnCount - 1) * compactModelsColumnGap;

      if (candidateWidth > maximumWidth) {
        break;
      }

      if (candidateWidth > currentWidth) {
        candidateWidths.add(candidateWidth);
      }
    }
  }

  let bestWidth = currentWidth;
  let bestHeight = measureCompactBodyHeight(bodyRows, currentWidth);

  for (const candidateWidth of Array.from(candidateWidths).sort((left, right) => left - right)) {
    const candidateHeight = measureCompactBodyHeight(bodyRows, candidateWidth);

    if (candidateHeight < bestHeight) {
      bestHeight = candidateHeight;
      bestWidth = candidateWidth;
    }
  }

  return bestWidth;
}

function renderTableWithModelsWidth(
  rows: UsageReportRow[],
  uncoloredBodyRows: string[][],
  tableLayout: UsageTableLayout,
  useColor: boolean,
  modelsColumnWidth: number,
): string {
  const wrappedBodyRows = prepareWrappedBodyRows(uncoloredBodyRows, tableLayout, modelsColumnWidth);
  const bodyRows = colorizeUsageBodyRows(wrappedBodyRows, rows, { useColor });
  const rowMetas: TableRowMeta[] = rows.map((row) => ({
    periodKey: row.periodKey,
    periodGroup: row.rowType === 'grand_total' ? 'summary' : 'normal',
    rowKind:
      row.rowType === 'grand_total'
        ? 'total'
        : row.rowType === 'period_combined'
          ? 'combined'
          : 'detail',
  }));

  return renderUnicodeTable({
    headerCells: colorizeHeader(useColor),
    bodyRows,
    measureHeaderCells: usageTableHeaders,
    measureBodyRows: wrappedBodyRows,
    rowMetas,
    layout: tableLayout === 'per_model_columns' ? 'top_aligned' : 'compact',
    multilineColumnIndex: modelsColumnIndex,
    multilineColumnWidth: modelsColumnWidth,
  });
}

export function renderTerminalTable(
  rows: UsageReportRow[],
  options: TerminalRenderOptions = {},
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const tableLayout = options.tableLayout ?? 'compact';
  const hasExplicitTerminalWidth = isValidTerminalWidth(options.terminalWidth);
  const terminalWidth = resolveTerminalWidth(options.terminalWidth);
  const uncoloredBodyRows = toUsageTableCells(rows, { layout: tableLayout });
  let modelsColumnWidth = defaultModelsColumnWidth;
  let renderedTable = renderTableWithModelsWidth(
    rows,
    uncoloredBodyRows,
    tableLayout,
    useColor,
    modelsColumnWidth,
  );

  if (terminalWidth !== undefined) {
    let renderedTableWidth = measureTableWidth(renderedTable);

    while (renderedTableWidth > terminalWidth && modelsColumnWidth > minimumModelsColumnWidth) {
      const overflowColumns = renderedTableWidth - terminalWidth;
      const nextModelsColumnWidth = Math.max(
        minimumModelsColumnWidth,
        modelsColumnWidth - overflowColumns,
      );

      if (nextModelsColumnWidth === modelsColumnWidth) {
        break;
      }

      modelsColumnWidth = nextModelsColumnWidth;
      renderedTable = renderTableWithModelsWidth(
        rows,
        uncoloredBodyRows,
        tableLayout,
        useColor,
        modelsColumnWidth,
      );
      renderedTableWidth = measureTableWidth(renderedTable);
    }

    if (renderedTableWidth < terminalWidth) {
      const maximumWidth = modelsColumnWidth + (terminalWidth - renderedTableWidth);
      const expandedWidth = resolveExpandedModelsColumnWidth(
        uncoloredBodyRows,
        tableLayout,
        modelsColumnWidth,
        maximumWidth,
      );

      if (expandedWidth > modelsColumnWidth) {
        modelsColumnWidth = expandedWidth;
        renderedTable = renderTableWithModelsWidth(
          rows,
          uncoloredBodyRows,
          tableLayout,
          useColor,
          modelsColumnWidth,
        );
        renderedTableWidth = measureTableWidth(renderedTable);
      }
    }

    if (hasExplicitTerminalWidth && renderedTableWidth > terminalWidth) {
      throw new Error(
        `Configured terminal width (${terminalWidth}) is too narrow for table rendering (minimum ${renderedTableWidth}).`,
      );
    }
  }

  return renderedTable;
}
