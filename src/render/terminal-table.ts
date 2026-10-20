import type { UsageReportRow } from '../domain/usage-report-row.js';
import { colorizeUsageBodyRows, createColorRoles } from './terminal-style-policy.js';
import {
  compactHiddenUsageColumns,
  getVisibleUsageColumnIndexes,
  selectColumns,
  toUsageTableCells,
  type UsageTableColumnId,
  type UsageTableLayout,
  type UsageTokenFormat,
  usageTableColumnKinds,
  usageTableHeaders,
} from './row-cells.js';
import {
  measureCellWidth,
  padEndVisible,
  resolveTerminalWidth,
  splitCellLines,
  truncateTableColumn,
  visibleWidth,
} from './table-text-layout.js';
import { findFittingStep, renderUnicodeTable, type TableRowMeta } from './unicode-table.js';

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
  /** Rows are listed as label/value lines because no table step fits the terminal. */
  stacked: boolean;
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

function colorizeHeader(headerCells: readonly string[], useColor: boolean): string[] {
  const { header: styleHeader } = createColorRoles(useColor);

  // Style each line on its own so a stacked header never carries color across lines.
  return headerCells.map((header) => splitCellLines(header).map(styleHeader).join('\n'));
}

function measureColumnWidth(rows: readonly (readonly string[])[], columnIndex: number): number {
  return rows.reduce((maxWidth, row) => Math.max(maxWidth, measureCellWidth(row[columnIndex])), 0);
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
          columnIndex === cells.length - 1 ? cell : padEndVisible(cell, longestLineWidth),
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

/** Colors usage cells (one usage row per cell row) and renders the step's visible columns. */
function renderUsageCells(
  rows: UsageReportRow[],
  cells: string[][],
  prepared: PreparedFitStep,
  options: {
    useColor: boolean;
    headerCells?: string[];
    multilineColumnIndex: number;
    multilineColumnWidth?: number;
    stackedTitleColumnCount?: number;
    terminalWidth: number | undefined;
  },
): string {
  const headerCells = options.headerCells ?? prepared.headerCells;
  const columns = prepared.visibleColumnIndexes;
  const coloredCells = colorizeUsageBodyRows(cells, rows, { useColor: options.useColor });

  return renderUnicodeTable({
    labelStyler: createColorRoles(options.useColor).label,
    headerCells: selectColumns(colorizeHeader(headerCells, options.useColor), columns),
    bodyRows: coloredCells.map((row) => selectColumns(row, columns)),
    measureHeaderCells: selectColumns(headerCells, columns),
    measureBodyRows: cells.map((row) => selectColumns(row, columns)),
    rowMetas: toRowMetas(rows),
    columnKinds: selectColumns(usageTableColumnKinds, columns),
    multilineColumnIndex: options.multilineColumnIndex,
    multilineColumnWidth: options.multilineColumnWidth,
    stackedTitleColumnCount: options.stackedTitleColumnCount,
    terminalWidth: options.terminalWidth,
  });
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
    /** Set when no step fits, so the rows are listed instead of boxed. */
    stackedWidth: number | undefined;
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
  const columns = prepared.visibleColumnIndexes;
  const output = renderUsageCells(rows, preparedRows, prepared, {
    useColor: options.useColor,
    multilineColumnIndex: prepared.showsModels
      ? columns.indexOf(modelsColumnIndex)
      : columns.indexOf(sourceColumnIndex),
    multilineColumnWidth: prepared.showsModels ? options.modelsColumnWidth : undefined,
    terminalWidth: options.stackedWidth,
  });

  return { output, truncatedModelNames };
}

/**
 * A list has no column budget, so it keeps Input and Output. Compact rows drop their model
 * lists; per-model rows keep them, one record per model.
 */
function resolveListStep(
  steps: readonly TableFitStep[],
  tableLayout: UsageTableLayout,
): TableFitStep | undefined {
  const droppedColumn: UsageTableColumnId = tableLayout === 'compact' ? 'models' : 'cacheWrite';

  return steps.find((step) => step.hiddenColumns.includes(droppedColumn));
}

/**
 * Lists a per-model table with one record per model, titled by period and source, so each
 * model's numbers stay with its name on a terminal too narrow for any table step.
 */
function renderPerModelList(
  rows: UsageReportRow[],
  prepared: PreparedFitStep,
  options: { useColor: boolean; terminalWidth: number | undefined },
): string {
  const listRows: UsageReportRow[] = [];
  const listCells: string[][] = [];

  prepared.uncoloredBodyRows.forEach((cells, rowIndex) => {
    const cellLines = cells.map((cell) => splitCellLines(cell));
    const modelLines = cellLines[modelsColumnIndex];
    // Without a per-model breakdown the metrics are row totals: keep the row whole.
    const hasModelMetrics = cellLines.every(
      (lines, columnIndex) =>
        usageTableColumnKinds[columnIndex] === 'text' || lines.length === modelLines.length,
    );
    const records = hasModelMetrics
      ? modelLines.map((modelLine, lineIndex) =>
          cellLines.map((lines, columnIndex) =>
            columnIndex === modelsColumnIndex
              ? modelLine.replace(/^• /u, '')
              : (lines[lineIndex] ?? lines[0]),
          ),
        )
      : [cells];

    for (const record of records) {
      listRows.push(rows[rowIndex]);
      listCells.push(record);
    }
  });

  const modelsIndex = prepared.visibleColumnIndexes.indexOf(modelsColumnIndex);

  return renderUsageCells(listRows, listCells, prepared, {
    useColor: options.useColor,
    headerCells: prepared.headerCells.map((header, columnIndex) =>
      columnIndex === modelsColumnIndex ? 'Model' : header,
    ),
    multilineColumnIndex: modelsIndex,
    stackedTitleColumnCount: modelsIndex,
    terminalWidth: options.terminalWidth,
  });
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
  const terminalWidth = resolveTerminalWidth(options.terminalWidth);
  const steps = resolveFitSteps(tableLayout, options.compact ?? false, options.hideCost ?? false);
  const fitted = findFittingStep(
    steps,
    (step) => prepareFitStep(rows, tableLayout, step),
    (candidate) => terminalWidth === undefined || fitsTerminal(candidate, terminalWidth),
  );
  let { prepared } = fitted;

  const stacked = !fitted.fits;

  if (stacked) {
    const listStep = resolveListStep(steps, tableLayout);

    if (listStep) {
      prepared = prepareFitStep(rows, tableLayout, listStep);
    }
  }

  const { output, truncatedModelNames } =
    stacked && tableLayout === 'per_model_columns'
      ? {
          output: renderPerModelList(rows, prepared, { useColor, terminalWidth }),
          truncatedModelNames: false,
        }
      : renderPreparedTable(rows, prepared, {
          tableLayout,
          useColor,
          modelsColumnWidth: resolveModelsColumnWidth(prepared, tableLayout, terminalWidth),
          packModels: terminalWidth !== undefined,
          stackedWidth: stacked ? terminalWidth : undefined,
        });

  return {
    output,
    fit: {
      tokenFormat: prepared.step.tokenFormat,
      hiddenColumns: [...prepared.step.hiddenColumns],
      truncatedModelNames,
      stacked,
    },
  };
}

export function renderTerminalTable(
  rows: UsageReportRow[],
  options: TerminalRenderOptions = {},
): string {
  return renderTerminalTableWithFit(rows, options).output;
}
