import pc from 'picocolors';

import type { UsageReportRow } from '../domain/usage-report-row.js';
import { colorizeUsageBodyRows } from './terminal-style-policy.js';
import {
  compactHiddenUsageColumns,
  getVisibleUsageColumnIndexes,
  selectColumns,
  toUsageTableCells,
  type UsageTableColumnId,
  type UsageTableLayout,
  type UsageTokenFormat,
  usageTableHeaders,
} from './row-cells.js';
import {
  resolveTtyColumns,
  splitCellLines,
  truncateTableColumn,
  visibleWidth,
} from './table-text-layout.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';

const modelsColumnIndex = 2;
const sourceColumnIndex = 1;
const defaultModelsColumnWidth = 32;
/** Narrowest models column before more columns are hidden; shorter names keep their width. */
const minimumModelsColumnWidth = 20;
const compactModelsColumnGap = 2;

type TableFitStep = {
  tokenFormat: UsageTokenFormat;
  hiddenColumns: readonly UsageTableColumnId[];
};

/**
 * Ordered from most to least detail. A table on a TTY uses the first step that fits the
 * terminal. Fitting never hides Period, Source, Cache Read, Total, or Cost.
 */
const tableFitSteps: readonly TableFitStep[] = [
  { tokenFormat: 'full', hiddenColumns: [] },
  { tokenFormat: 'abbreviated', hiddenColumns: [] },
  { tokenFormat: 'abbreviated', hiddenColumns: compactHiddenUsageColumns },
  { tokenFormat: 'abbreviated', hiddenColumns: [...compactHiddenUsageColumns, 'models'] },
  {
    tokenFormat: 'abbreviated',
    hiddenColumns: [...compactHiddenUsageColumns, 'models', 'input', 'output'],
  },
];

/** `--compact` starts here: abbreviated token counts without Reasoning and Cache Write. */
const compactTableFitStepIndex = 2;

const stackedHeaders: Partial<Record<string, string>> = {
  'Cache Read': 'Cache\nRead',
  'Cache Write': 'Cache\nWrite',
};

export type TerminalTableFit = {
  tokenFormat: UsageTokenFormat;
  hiddenColumns: UsageTableColumnId[];
  truncatedModelNames: boolean;
};

type TerminalRenderOptions = {
  useColor?: boolean;
  tableLayout?: UsageTableLayout;
  terminalWidth?: number;
  /** Start from the compact step even when the full table would fit. */
  compact?: boolean;
  /** `--no-cost`: leave out the Cost column at every step. */
  hideCost?: boolean;
};

type PreparedFitStep = {
  step: TableFitStep;
  uncoloredBodyRows: string[][];
  headerCells: string[];
  visibleColumnIndexes: number[];
  showsModels: boolean;
  /** Table width without the models column content. */
  fixedWidth: number;
  longestModelLineWidth: number;
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

function styleHeader(header: string, index: number): string {
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
}

function colorizeHeader(headerCells: readonly string[], useColor: boolean): string[] {
  if (!useColor) {
    return [...headerCells];
  }

  // Style each line on its own so a stacked header never carries color across lines.
  return headerCells.map((header, index) =>
    splitCellLines(header)
      .map((line) => styleHeader(line, index))
      .join('\n'),
  );
}

function isValidTerminalWidth(width: unknown): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0;
}

function resolveTerminalWidth(override: number | undefined): number | undefined {
  if (isValidTerminalWidth(override)) {
    return Math.floor(override);
  }

  return resolveTtyColumns(process.stdout);
}

function measureTableWidth(tableOutput: string): number {
  return tableOutput
    .trimEnd()
    .split('\n')
    .reduce((maxWidth, line) => Math.max(maxWidth, visibleWidth(line)), 0);
}

function measureCellWidth(cell: string): number {
  return splitCellLines(cell).reduce((maxWidth, line) => Math.max(maxWidth, visibleWidth(line)), 0);
}

function measureColumnWidth(rows: readonly (readonly string[])[], columnIndex: number): number {
  return rows.reduce((maxWidth, row) => Math.max(maxWidth, measureCellWidth(row[columnIndex])), 0);
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

/** Packs model lists into the column, then shortens names that still do not fit. */
function prepareModelsColumn(
  bodyRows: string[][],
  tableLayout: UsageTableLayout,
  modelsColumnWidth: number,
): string[][] {
  const laidOutRows = layoutModelsColumn(bodyRows, tableLayout, modelsColumnWidth);

  return truncateTableColumn(laidOutRows, {
    columnIndex: modelsColumnIndex,
    width: modelsColumnWidth,
  });
}

function measureCompactBodyHeight(bodyRows: string[][], modelsColumnWidth: number): number {
  return prepareModelsColumn(bodyRows, 'compact', modelsColumnWidth).reduce(
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
    const longestModelLineWidth = measureColumnWidth(bodyRows, modelsColumnIndex);
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
    const longestLineWidth = measureCellWidth(row[modelsColumnIndex] ?? '');

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

function resolveFitSteps(
  tableLayout: UsageTableLayout,
  compact: boolean,
  hideCost: boolean,
): TableFitStep[] {
  const steps = tableFitSteps.slice(compact ? compactTableFitStepIndex : 0).map((step) => {
    // Per-model metric lines are unreadable without their model names.
    const hiddenColumns =
      tableLayout === 'per_model_columns'
        ? step.hiddenColumns.filter((column) => column !== 'models')
        : step.hiddenColumns;

    return {
      ...step,
      hiddenColumns: hideCost ? [...hiddenColumns, 'cost' as const] : hiddenColumns,
    };
  });

  // Hidden sets only grow along the ladder, so equal sizes mean equal sets.
  return steps.filter((step, index) => {
    const previousStep = steps[index - 1];

    return (
      index === 0 ||
      step.tokenFormat !== previousStep.tokenFormat ||
      step.hiddenColumns.length !== previousStep.hiddenColumns.length
    );
  });
}

function prepareFitStep(
  rows: UsageReportRow[],
  tableLayout: UsageTableLayout,
  step: TableFitStep,
): PreparedFitStep {
  const uncoloredBodyRows = toUsageTableCells(rows, {
    layout: tableLayout,
    tokenFormat: step.tokenFormat,
  });
  const headerCells = usageTableHeaders.map((header) =>
    step.tokenFormat === 'abbreviated' ? (stackedHeaders[header] ?? header) : header,
  );
  const visibleColumnIndexes = getVisibleUsageColumnIndexes(new Set(step.hiddenColumns));
  const showsModels = visibleColumnIndexes.includes(modelsColumnIndex);
  const measureRows = [headerCells, ...uncoloredBodyRows];
  const contentWidth = visibleColumnIndexes
    .filter((columnIndex) => columnIndex !== modelsColumnIndex)
    .reduce((width, columnIndex) => width + measureColumnWidth(measureRows, columnIndex), 0);

  return {
    step,
    uncoloredBodyRows,
    headerCells,
    visibleColumnIndexes,
    showsModels,
    fixedWidth: contentWidth + 3 * visibleColumnIndexes.length + 1,
    longestModelLineWidth: measureColumnWidth(measureRows, modelsColumnIndex),
  };
}

function fitsTerminal(prepared: PreparedFitStep, terminalWidth: number): boolean {
  const availableWidth = terminalWidth - prepared.fixedWidth;

  if (!prepared.showsModels) {
    return availableWidth >= 0;
  }

  return availableWidth >= Math.min(prepared.longestModelLineWidth, minimumModelsColumnWidth);
}

function resolveModelsColumnWidth(
  prepared: PreparedFitStep,
  tableLayout: UsageTableLayout,
  terminalWidth: number | undefined,
): number {
  if (!prepared.showsModels) {
    return 0;
  }

  const preferredWidth = Math.max(defaultModelsColumnWidth, prepared.longestModelLineWidth);

  if (terminalWidth === undefined) {
    return preferredWidth;
  }

  const availableWidth = terminalWidth - prepared.fixedWidth;
  const minimumWidth = Math.min(prepared.longestModelLineWidth, minimumModelsColumnWidth);
  const baseWidth = Math.max(minimumWidth, Math.min(preferredWidth, availableWidth));

  return resolveExpandedModelsColumnWidth(
    prepared.uncoloredBodyRows,
    tableLayout,
    baseWidth,
    availableWidth,
  );
}

function toRowMetas(rows: UsageReportRow[]): TableRowMeta[] {
  return rows.map((row) => ({
    periodKey: row.periodKey,
    periodGroup: row.rowType === 'grand_total' ? 'summary' : 'normal',
    rowKind:
      row.rowType === 'grand_total'
        ? 'total'
        : row.rowType === 'period_combined'
          ? 'combined'
          : 'detail',
  }));
}

function renderPreparedTable(
  rows: UsageReportRow[],
  prepared: PreparedFitStep,
  options: {
    tableLayout: UsageTableLayout;
    useColor: boolean;
    modelsColumnWidth: number;
    /** Pack model lists side by side; only worth it when a terminal width bounds the table. */
    packModels: boolean;
  },
): { output: string; truncatedModelNames: boolean } {
  const laidOutRows =
    prepared.showsModels && options.packModels
      ? layoutModelsColumn(
          prepared.uncoloredBodyRows,
          options.tableLayout,
          options.modelsColumnWidth,
        )
      : prepared.uncoloredBodyRows;
  const preparedRows = prepared.showsModels
    ? truncateTableColumn(laidOutRows, {
        columnIndex: modelsColumnIndex,
        width: options.modelsColumnWidth,
      })
    : laidOutRows;
  const truncatedModelNames = preparedRows.some(
    (row, index) => row[modelsColumnIndex] !== laidOutRows[index][modelsColumnIndex],
  );
  const coloredRows = colorizeUsageBodyRows(preparedRows, rows, { useColor: options.useColor });
  const columns = prepared.visibleColumnIndexes;
  const output = renderUnicodeTable({
    headerCells: selectColumns(colorizeHeader(prepared.headerCells, options.useColor), columns),
    bodyRows: coloredRows.map((row) => selectColumns(row, columns)),
    measureHeaderCells: selectColumns(prepared.headerCells, columns),
    measureBodyRows: preparedRows.map((row) => selectColumns(row, columns)),
    rowMetas: toRowMetas(rows),
    layout: options.tableLayout === 'per_model_columns' ? 'top_aligned' : 'compact',
    multilineColumnIndex: prepared.showsModels
      ? columns.indexOf(modelsColumnIndex)
      : columns.indexOf(sourceColumnIndex),
    multilineColumnWidth: prepared.showsModels ? options.modelsColumnWidth : undefined,
  });

  return { output, truncatedModelNames };
}

/**
 * Renders the usage table at the most detailed step that fits the terminal. Without a
 * known terminal width (piped output) every column stays, unless `compact` is set.
 */
export function renderTerminalTableWithFit(
  rows: UsageReportRow[],
  options: TerminalRenderOptions = {},
): { output: string; fit: TerminalTableFit } {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const tableLayout = options.tableLayout ?? 'compact';
  const hasExplicitTerminalWidth = isValidTerminalWidth(options.terminalWidth);
  const terminalWidth = resolveTerminalWidth(options.terminalWidth);
  const steps = resolveFitSteps(tableLayout, options.compact ?? false, options.hideCost ?? false);
  let prepared = prepareFitStep(rows, tableLayout, steps[0]);

  if (terminalWidth !== undefined) {
    for (const step of steps.slice(1)) {
      if (fitsTerminal(prepared, terminalWidth)) {
        break;
      }

      prepared = prepareFitStep(rows, tableLayout, step);
    }
  }

  const modelsColumnWidth = resolveModelsColumnWidth(prepared, tableLayout, terminalWidth);
  const { output, truncatedModelNames } = renderPreparedTable(rows, prepared, {
    tableLayout,
    useColor,
    modelsColumnWidth,
    packModels: terminalWidth !== undefined,
  });

  if (hasExplicitTerminalWidth && terminalWidth !== undefined) {
    const renderedTableWidth = measureTableWidth(output);

    if (renderedTableWidth > terminalWidth) {
      throw new Error(
        `Configured terminal width (${terminalWidth}) is too narrow for table rendering (minimum ${renderedTableWidth}).`,
      );
    }
  }

  return {
    output,
    fit: {
      tokenFormat: prepared.step.tokenFormat,
      hiddenColumns: [...prepared.step.hiddenColumns],
      truncatedModelNames,
    },
  };
}

export function renderTerminalTable(
  rows: UsageReportRow[],
  options: TerminalRenderOptions = {},
): string {
  return renderTerminalTableWithFit(rows, options).output;
}
