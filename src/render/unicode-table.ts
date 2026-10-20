import { stripVTControlCharacters } from 'node:util';

import {
  measureCellWidth,
  splitCellLines,
  visibleWidth,
  wrapTableColumn,
} from './table-text-layout.js';
import type { TextStyler } from './terminal-style-policy.js';

type TableAlignment = 'left' | 'right';

/**
 * `text` columns (keys, labels, names, dates) align left; `measure` columns (counts,
 * tokens, money, durations) align right.
 */
export type TableColumnKind = 'text' | 'measure';

export type TableRowMeta = {
  periodKey: string;
  periodGroup?: 'normal' | 'summary';
  rowKind: 'detail' | 'combined' | 'total';
};

/**
 * How a table too wide for the terminal gives up detail. The full table comes first,
 * then the abbreviated cells, then the abbreviated cells with the hideable columns left
 * out one more at a time. Rows are listed only when even the last of these is too wide.
 */
export type UnicodeTableFit = {
  /** The body cells with abbreviated measures, such as `24.3K` for `24,312` tokens. */
  abbreviatedBodyRows?: string[][];
  /** Uncolored `abbreviatedBodyRows`, to measure; those rows when omitted. */
  abbreviatedMeasureBodyRows?: string[][];
  /** Minor columns (indexes in the full table), hidden in this order. */
  hideableColumns?: readonly number[];
};

/** One version of the table, from the full table down to the narrowest. */
type FitStep = {
  bodyRows?: string[][];
  measureBodyRows?: string[][];
  hiddenColumns?: readonly number[];
};

type RenderUnicodeTableOptions = {
  headerCells: readonly string[];
  bodyRows: string[][];
  measureHeaderCells: readonly string[];
  /**
   * Uncolored `bodyRows`, to measure. A listed row takes its title from these cells, so
   * hold text here unwrapped when the table wraps it, and fix `multilineColumnWidth`.
   */
  measureBodyRows: string[][];
  rowMetas: TableRowMeta[];
  /** One kind per column; it sets the column's alignment. */
  columnKinds: readonly TableColumnKind[];
  /** The column that holds wrapped multi-line text. */
  multilineColumnIndex: number;
  /** Fixed width for the multiline column; measured from its content when omitted. */
  multilineColumnWidth?: number;
  /**
   * When the boxed table is wider than this, it is fitted (see `fit`), and each row is
   * listed as label/value lines when it still does not fit.
   */
  terminalWidth?: number;
  /** Styles the labels of a listed row; pass the `label` color role. */
  labelStyler: TextStyler;
  fit?: UnicodeTableFit;
  /** Leading columns that name a listed row; defaults to those up to the multiline column. */
  stackedTitleColumnCount?: number;
};

type BorderChars = {
  left: string;
  join: string;
  right: string;
};

/** The table's cells at one fit step: rows in display order, hidden columns left out. */
type PreparedTable = {
  headerRow: string[];
  measureHeaderRow: string[];
  bodyRows: string[][];
  measureBodyRows: string[][];
  columnKinds: TableColumnKind[];
  widths: number[];
};

/** Converts markdown-style column alignment (`l`/`r`) to column kinds. */
export function columnKindsFromAlign(align: readonly ('l' | 'r')[]): TableColumnKind[] {
  return align.map((columnAlign) => (columnAlign === 'r' ? 'measure' : 'text'));
}

function getColumnAlignment(kind: TableColumnKind): TableAlignment {
  return kind === 'measure' ? 'right' : 'left';
}

function alignCellLine(value: string, width: number, alignment: TableAlignment): string {
  const padding = Math.max(0, width - visibleWidth(value));

  if (alignment === 'right') {
    return `${' '.repeat(padding)}${value}`;
  }

  return `${value}${' '.repeat(padding)}`;
}

/** Every cell starts on the row's first line, so a value sits beside its row's name. */
function padCellLines(lines: string[], rowHeight: number): string[] {
  const missingLineCount = rowHeight - lines.length;

  if (missingLineCount <= 0) {
    return lines;
  }

  return [...lines, ...Array.from({ length: missingLineCount }, () => '')];
}

function toRenderableRowLines(
  row: readonly string[],
  options: {
    widths: number[];
    columnKinds: readonly TableColumnKind[];
  },
): string[] {
  const cellLines = row.map((cell) => splitCellLines(cell));
  const rowHeight = cellLines.reduce((max, lines) => Math.max(max, lines.length), 1);

  const paddedAlignedColumns = cellLines.map((lines, columnIndex) => {
    const alignedLines = padCellLines(lines, rowHeight);
    const horizontalAlignment = getColumnAlignment(options.columnKinds[columnIndex]);

    return alignedLines.map((line) =>
      alignCellLine(line, options.widths[columnIndex], horizontalAlignment),
    );
  });

  return Array.from({ length: rowHeight }, (_, lineIndex) => {
    const lineCells = paddedAlignedColumns.map((columnLines) => columnLines[lineIndex]);
    return `│ ${lineCells.join(' │ ')} │`;
  });
}

function buildBorderLine(widths: number[], chars: BorderChars): string {
  const segments = widths.map((width) => '─'.repeat(width + 2));
  return `${chars.left}${segments.join(chars.join)}${chars.right}`;
}

/** A rule separates period groups and sets off the TOTAL row; rows within a group share it. */
function shouldDrawBodySeparator(index: number, rowMetas: TableRowMeta[]): boolean {
  if (index < 0 || index >= rowMetas.length - 1) {
    return false;
  }

  const previousRow = rowMetas[index];
  const nextRow = rowMetas[index + 1];

  return nextRow.rowKind === 'total' || previousRow.periodKey !== nextRow.periodKey;
}

function getRowKindWeight(rowKind: TableRowMeta['rowKind']): number {
  switch (rowKind) {
    case 'detail':
      return 0;
    case 'combined':
      return 1;
    case 'total':
      return 2;
  }
}

function compareRowMetas(left: TableRowMeta, right: TableRowMeta): number {
  const leftPeriodGroup = left.periodGroup === 'summary' ? 1 : 0;
  const rightPeriodGroup = right.periodGroup === 'summary' ? 1 : 0;
  const leftPeriodKey = left.periodKey;
  const rightPeriodKey = right.periodKey;

  if (leftPeriodGroup !== rightPeriodGroup) {
    return leftPeriodGroup - rightPeriodGroup;
  }

  if (leftPeriodKey !== rightPeriodKey) {
    return leftPeriodKey < rightPeriodKey ? -1 : 1;
  }

  return getRowKindWeight(left.rowKind) - getRowKindWeight(right.rowKind);
}

function getMaxRowColumnCount(
  rows: readonly (readonly string[])[],
  minimumColumnCount: number,
): number {
  return rows.reduce(
    (maxColumnCount, row) => Math.max(maxColumnCount, row.length),
    minimumColumnCount,
  );
}

/**
 * Row indexes in display order: grouped by period, details before their combined row,
 * TOTAL last. Rows keep their given order when their counts disagree with the metas.
 */
function resolveRowOrder(options: RenderUnicodeTableOptions): number[] {
  const indexes = options.rowMetas.map((_, index) => index);
  const hasAlignedRowCounts =
    options.rowMetas.length === options.bodyRows.length &&
    options.rowMetas.length === options.measureBodyRows.length;

  if (!hasAlignedRowCounts) {
    return indexes;
  }

  return indexes.sort(
    (left, right) =>
      compareRowMetas(options.rowMetas[left], options.rowMetas[right]) || left - right,
  );
}

function computeColumnWidths(
  measureRows: readonly (readonly string[])[],
  options: { multilineColumnIndex: number; multilineColumnWidth?: number },
): number[] {
  const columnCount = measureRows.reduce(
    (maxColumnCount, row) => Math.max(maxColumnCount, row.length),
    0,
  );
  const widths = Array.from({ length: columnCount }, () => 0);

  for (const row of measureRows) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      for (const line of splitCellLines(row[columnIndex] ?? '')) {
        widths[columnIndex] = Math.max(widths[columnIndex], visibleWidth(line));
      }
    }
  }

  if (options.multilineColumnWidth !== undefined && options.multilineColumnIndex >= 0) {
    widths[options.multilineColumnIndex] = options.multilineColumnWidth;
  }

  return widths;
}

function prepareTable(
  options: RenderUnicodeTableOptions,
  rowOrder: readonly number[],
  step: FitStep,
): PreparedTable {
  const bodyRows = step.bodyRows ?? options.bodyRows;
  const measureBodyRows = step.measureBodyRows ?? step.bodyRows ?? options.measureBodyRows;
  const columnCount = Math.max(
    getMaxRowColumnCount(bodyRows, options.headerCells.length),
    getMaxRowColumnCount(measureBodyRows, options.measureHeaderCells.length),
  );
  const hiddenColumns = new Set(step.hiddenColumns);
  const visibleColumnIndexes = Array.from({ length: columnCount }, (_, index) => index).filter(
    (columnIndex) => !hiddenColumns.has(columnIndex),
  );
  // Short or missing rows (ragged input) get empty cells.
  const selectVisible = (row: readonly string[] | undefined): string[] =>
    visibleColumnIndexes.map((columnIndex) => row?.[columnIndex] ?? '');
  const measureHeaderRow = selectVisible(options.measureHeaderCells);
  const orderedMeasureRows = rowOrder.map((rowIndex) => selectVisible(measureBodyRows[rowIndex]));
  const multilineColumnIndex = visibleColumnIndexes.indexOf(options.multilineColumnIndex);

  return {
    headerRow: selectVisible(options.headerCells),
    measureHeaderRow,
    bodyRows: rowOrder.map((rowIndex) => selectVisible(bodyRows[rowIndex])),
    measureBodyRows: orderedMeasureRows,
    // Cells past the declared kinds (ragged rows) are treated as text.
    columnKinds: visibleColumnIndexes.map(
      (columnIndex): TableColumnKind => options.columnKinds[columnIndex] ?? 'text',
    ),
    widths: computeColumnWidths([measureHeaderRow, ...orderedMeasureRows], {
      multilineColumnIndex,
      multilineColumnWidth: options.multilineColumnWidth,
    }),
  };
}

/** The full table, then each step of `fit`; see `UnicodeTableFit`. */
function resolveFitSteps(fit: UnicodeTableFit | undefined): FitStep[] {
  const abbreviated = {
    bodyRows: fit?.abbreviatedBodyRows,
    measureBodyRows: fit?.abbreviatedMeasureBodyRows,
  };
  const hideableColumns = fit?.hideableColumns ?? [];

  return [
    {},
    ...(abbreviated.bodyRows ? [abbreviated] : []),
    ...hideableColumns.map((_, index) => ({
      ...abbreviated,
      hiddenColumns: hideableColumns.slice(0, index + 1),
    })),
  ];
}

/**
 * Prepares steps in order, from most to least detail, and returns the first that fits;
 * when none does, the last one with `fits: false`. A step is only prepared when every
 * step before it was too wide.
 */
export function findFittingStep<Step, Prepared>(
  steps: readonly Step[],
  prepare: (step: Step) => Prepared,
  fits: (prepared: Prepared) => boolean,
): { prepared: Prepared; fits: boolean } {
  let prepared = prepare(steps[0]);

  for (const step of steps.slice(1)) {
    if (fits(prepared)) {
      return { prepared, fits: true };
    }

    prepared = prepare(step);
  }

  return { prepared, fits: fits(prepared) };
}

function measureBoxedTableWidth(widths: readonly number[]): number {
  return widths.reduce((total, width) => total + width + 3, 1);
}

function joinCellLines(cell: string): string {
  return splitCellLines(cell).join(' ');
}

/**
 * Wraps a plain line after spaces, `/`, `-`, or `_` so model names, paths, and note codes
 * break between their parts; a part wider than the line is broken by width.
 */
export function wrapAtNameBreaks(line: string, width: number): string[] {
  const lines: string[] = [];

  for (const piece of line.split(/(?<=[\s/_-])/u)) {
    const lastLine = lines.at(-1);

    if (lastLine !== undefined && visibleWidth((lastLine + piece).trimEnd()) <= width) {
      lines[lines.length - 1] = lastLine + piece;
    } else {
      lines.push(piece);
    }
  }

  return lines.flatMap((wrappedLine) =>
    splitCellLines(wrapTableColumn([[wrappedLine.trimEnd()]], { columnIndex: 0, width })[0][0]),
  );
}

/**
 * Lists each row as a title line (the identifying columns) followed by one label/value
 * line per remaining column, for terminals too narrow for the boxed table. Measure
 * values share one right edge, the widest measure value in the list; text is unpadded.
 * A title stays whole, so a path can be copied, unless it is wider than the terminal:
 * then it wraps at name breaks, uncolored.
 */
function renderStackedRows(options: {
  headerCells: readonly string[];
  measureHeaderCells: readonly string[];
  bodyRows: string[][];
  measureBodyRows: string[][];
  titleColumnCount: number;
  columnKinds: readonly TableColumnKind[];
  terminalWidth: number;
  labelStyler: TextStyler;
}): string {
  const valueColumnIndexes = options.headerCells
    .map((_, columnIndex) => columnIndex)
    .filter((columnIndex) => columnIndex >= options.titleColumnCount);
  const labelWidth = valueColumnIndexes.reduce(
    (maxWidth, columnIndex) =>
      Math.max(maxWidth, visibleWidth(joinCellLines(options.measureHeaderCells[columnIndex]))),
    0,
  );
  const continuationIndent = ' '.repeat(2 + labelWidth + 2);
  const availableValueWidth = Math.max(1, options.terminalWidth - continuationIndent.length);
  const measureWidth = Math.min(
    availableValueWidth,
    options.measureBodyRows.reduce(
      (maxWidth, row) =>
        valueColumnIndexes.reduce(
          (rowMax, columnIndex) =>
            options.columnKinds[columnIndex] === 'measure'
              ? Math.max(rowMax, measureCellWidth(row[columnIndex]))
              : rowMax,
          maxWidth,
        ),
      0,
    ),
  );

  const records = options.bodyRows.map((row, rowIndex) => {
    // A cell the table wrapped is titled from its measure cell, so it reads whole; a
    // one-line cell keeps its color.
    const title = row
      .slice(0, options.titleColumnCount)
      .map((cell, columnIndex) =>
        joinCellLines(
          (splitCellLines(cell).length > 1 && options.measureBodyRows[rowIndex][columnIndex]) ||
            cell,
        ),
      )
      .filter((cell) => cell.trim().length > 0)
      .join(' · ');
    const titleLines =
      visibleWidth(title) > options.terminalWidth
        ? wrapAtNameBreaks(stripVTControlCharacters(title), options.terminalWidth)
        : [title];
    const valueLines = valueColumnIndexes.flatMap((columnIndex) => {
      // A line too long for the terminal is wrapped from its uncolored text, without the
      // padding that aligned it in the boxed table; the lines that fit stay as they are.
      // A cell the table wrapped (its measure cell has other lines) is listed unwrapped.
      const measureCell = options.measureBodyRows[rowIndex][columnIndex];
      const measureLines = splitCellLines(measureCell);
      const bodyLines = splitCellLines(row[columnIndex]);
      const listedLines =
        measureCell && measureLines.length !== bodyLines.length ? measureLines : bodyLines;
      const lines = listedLines.flatMap((line, lineIndex) =>
        visibleWidth(line) > availableValueWidth
          ? wrapAtNameBreaks(
              (measureLines[lineIndex] ?? line).replace(/ {2,}/gu, ' '),
              availableValueWidth,
            )
          : [line],
      );

      if (lines.every((line) => line.trim().length === 0)) {
        return [];
      }

      const alignment = getColumnAlignment(options.columnKinds[columnIndex]);
      const label = alignCellLine(
        options.labelStyler(joinCellLines(options.measureHeaderCells[columnIndex])),
        labelWidth,
        'left',
      );

      return lines.map((line, lineIndex) => {
        const value = alignCellLine(line, measureWidth, alignment).trimEnd();
        return lineIndex === 0 ? `  ${label}  ${value}` : `${continuationIndent}${value}`;
      });
    });

    return [...titleLines, ...valueLines].join('\n');
  });

  return records.join('\n\n');
}

export function renderUnicodeTable(options: RenderUnicodeTableOptions): string {
  const rowOrder = resolveRowOrder(options);
  const rowMetas = rowOrder.map((rowIndex) => options.rowMetas[rowIndex]);
  const steps = resolveFitSteps(options.fit);
  const prepare = (step: FitStep) => prepareTable(options, rowOrder, step);
  const { terminalWidth } = options;
  const fitted = findFittingStep(
    steps,
    prepare,
    (table) => terminalWidth === undefined || measureBoxedTableWidth(table.widths) <= terminalWidth,
  );

  if (terminalWidth !== undefined && !fitted.fits) {
    // A list has no column budget, so it shows every column in full detail.
    const fullTable = steps.length === 1 ? fitted.prepared : prepare(steps[0]);

    return renderStackedRows({
      headerCells: fullTable.headerRow,
      measureHeaderCells: fullTable.measureHeaderRow,
      bodyRows: fullTable.bodyRows,
      measureBodyRows: fullTable.measureBodyRows,
      titleColumnCount: options.stackedTitleColumnCount ?? options.multilineColumnIndex + 1,
      terminalWidth,
      columnKinds: fullTable.columnKinds,
      labelStyler: options.labelStyler,
    });
  }

  const { headerRow, bodyRows, columnKinds, widths } = fitted.prepared;
  const outputLines: string[] = [];

  outputLines.push(
    buildBorderLine(widths, {
      left: '╭',
      join: '┬',
      right: '╮',
    }),
  );
  outputLines.push(
    ...toRenderableRowLines(headerRow, {
      widths,
      columnKinds,
    }),
  );
  outputLines.push(
    buildBorderLine(widths, {
      left: '├',
      join: '┼',
      right: '┤',
    }),
  );

  bodyRows.forEach((row, rowIndex) => {
    outputLines.push(
      ...toRenderableRowLines(row, {
        widths,
        columnKinds,
      }),
    );

    if (shouldDrawBodySeparator(rowIndex, rowMetas)) {
      outputLines.push(
        buildBorderLine(widths, {
          left: '├',
          join: '┼',
          right: '┤',
        }),
      );
    }
  });

  outputLines.push(
    buildBorderLine(widths, {
      left: '╰',
      join: '┴',
      right: '╯',
    }),
  );

  return outputLines.join('\n');
}
