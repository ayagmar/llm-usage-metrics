import { splitCellLines, visibleWidth, wrapTableColumn } from './table-text-layout.js';

type TableAlignment = 'left' | 'right';
type TableVerticalAlignment = 'top' | 'middle';

/**
 * `text` columns (keys, labels, names, dates) align left; `measure` columns (counts,
 * tokens, money, durations) align right.
 */
export type TableColumnKind = 'text' | 'measure';

export type UnicodeTableLayout = 'compact' | 'top_aligned';

export type TableRowMeta = {
  periodKey: string;
  periodGroup?: 'normal' | 'summary';
  rowKind: 'detail' | 'combined' | 'total';
};

type RenderUnicodeTableOptions = {
  headerCells: readonly string[];
  bodyRows: string[][];
  measureHeaderCells: readonly string[];
  measureBodyRows: string[][];
  rowMetas: TableRowMeta[];
  layout: UnicodeTableLayout;
  /** One kind per column; it sets the column's alignment. */
  columnKinds: readonly TableColumnKind[];
  /** The column that holds wrapped multi-line text. */
  multilineColumnIndex: number;
  /** Fixed width for the multiline column; measured from its content when omitted. */
  multilineColumnWidth?: number;
  /** When the boxed table is wider than this, each row is listed as label/value lines. */
  terminalWidth?: number;
  /** Leading columns that name a listed row; defaults to those up to the multiline column. */
  stackedTitleColumnCount?: number;
};

type BorderChars = {
  left: string;
  join: string;
  right: string;
};

type RenderableTableRow = {
  rowMeta: TableRowMeta;
  bodyRow: string[];
  measureBodyRow: string[];
  originalIndex: number;
};

/** Converts markdown-style column alignment (`l`/`r`) to column kinds. */
export function columnKindsFromAlign(align: readonly ('l' | 'r')[]): TableColumnKind[] {
  return align.map((columnAlign) => (columnAlign === 'r' ? 'measure' : 'text'));
}

function getColumnAlignment(kind: TableColumnKind): TableAlignment {
  return kind === 'measure' ? 'right' : 'left';
}

function getVerticalAlignment(
  kind: TableColumnKind,
  layout: UnicodeTableLayout,
): TableVerticalAlignment {
  if (kind === 'text') {
    return 'top';
  }

  return layout === 'top_aligned' ? 'top' : 'middle';
}

function alignCellLine(value: string, width: number, alignment: TableAlignment): string {
  const padding = Math.max(0, width - visibleWidth(value));

  if (alignment === 'right') {
    return `${' '.repeat(padding)}${value}`;
  }

  return `${value}${' '.repeat(padding)}`;
}

function padCellLines(
  lines: string[],
  rowHeight: number,
  verticalAlignment: TableVerticalAlignment,
): string[] {
  const missingLineCount = rowHeight - lines.length;

  if (missingLineCount <= 0) {
    return lines;
  }

  if (verticalAlignment === 'top') {
    return [...lines, ...Array.from({ length: missingLineCount }, () => '')];
  }

  const topPadding = Math.floor(missingLineCount / 2);
  const bottomPadding = missingLineCount - topPadding;

  return [
    ...Array.from({ length: topPadding }, () => ''),
    ...lines,
    ...Array.from({ length: bottomPadding }, () => ''),
  ];
}

function toRenderableRowLines(
  row: readonly string[],
  options: {
    widths: number[];
    layout: UnicodeTableLayout;
    columnKinds: readonly TableColumnKind[];
  },
): string[] {
  const cellLines = row.map((cell) => splitCellLines(cell));
  const rowHeight = cellLines.reduce((max, lines) => Math.max(max, lines.length), 1);

  const paddedAlignedColumns = cellLines.map((lines, columnIndex) => {
    const kind = options.columnKinds[columnIndex];
    const alignedLines = padCellLines(lines, rowHeight, getVerticalAlignment(kind, options.layout));
    const horizontalAlignment = getColumnAlignment(kind);

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

function shouldDrawBodySeparator(index: number, rowMetas: TableRowMeta[]): boolean {
  if (index < 0 || index >= rowMetas.length - 1) {
    return false;
  }

  const previousRow = rowMetas[index];
  const nextRow = rowMetas[index + 1];

  return (
    (previousRow.rowKind === 'detail' &&
      (nextRow.rowKind === 'detail' || nextRow.rowKind === 'combined') &&
      previousRow.periodKey === nextRow.periodKey) ||
    previousRow.rowKind === 'combined' ||
    nextRow.rowKind === 'total' ||
    previousRow.periodKey !== nextRow.periodKey
  );
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

function padRowToColumnCount(row: string[] | undefined, columnCount: number): string[] {
  const normalizedRow = row ?? [];

  if (normalizedRow.length >= columnCount) {
    return normalizedRow;
  }

  return [
    ...normalizedRow,
    ...Array.from({ length: columnCount - normalizedRow.length }, () => ''),
  ];
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

function normalizeRenderableRows(options: {
  rowMetas: TableRowMeta[];
  bodyRows: string[][];
  measureBodyRows: string[][];
  columnCount: number;
}): RenderableTableRow[] {
  const hasAlignedRowCounts =
    options.rowMetas.length === options.bodyRows.length &&
    options.rowMetas.length === options.measureBodyRows.length;

  const rows = options.rowMetas.map((rowMeta, index) => ({
    rowMeta,
    bodyRow: padRowToColumnCount(options.bodyRows[index], options.columnCount),
    measureBodyRow: padRowToColumnCount(options.measureBodyRows[index], options.columnCount),
    originalIndex: index,
  }));

  if (!hasAlignedRowCounts) {
    return rows;
  }

  return rows.sort((left, right) => {
    const comparison = compareRowMetas(left.rowMeta, right.rowMeta);

    if (comparison !== 0) {
      return comparison;
    }

    return left.originalIndex - right.originalIndex;
  });
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

  if (options.multilineColumnWidth !== undefined) {
    widths[options.multilineColumnIndex] = options.multilineColumnWidth;
  }

  return widths;
}

function measureBoxedTableWidth(widths: readonly number[]): number {
  return widths.reduce((total, width) => total + width + 3, 1);
}

function measureLinesWidth(cell: string): number {
  return splitCellLines(cell).reduce((maxWidth, line) => Math.max(maxWidth, visibleWidth(line)), 0);
}

function joinCellLines(cell: string): string {
  return splitCellLines(cell).join(' ');
}

/**
 * Wraps a plain line after spaces, `/`, or `-` so model names and paths break between
 * their parts; a part wider than the line is broken by width.
 */
function wrapAtNameBreaks(line: string, width: number): string[] {
  const lines: string[] = [];

  for (const piece of line.split(/(?<=[\s/-])/u)) {
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
 */
function renderStackedRows(options: {
  headerCells: readonly string[];
  measureHeaderCells: readonly string[];
  bodyRows: string[][];
  measureBodyRows: string[][];
  titleColumnCount: number;
  columnKinds: readonly TableColumnKind[];
  terminalWidth: number;
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
              ? Math.max(rowMax, measureLinesWidth(row[columnIndex]))
              : rowMax,
          maxWidth,
        ),
      0,
    ),
  );

  const records = options.bodyRows.map((row, rowIndex) => {
    const title = row
      .slice(0, options.titleColumnCount)
      .map(joinCellLines)
      .filter((cell) => cell.trim().length > 0)
      .join(' · ');
    const valueLines = valueColumnIndexes.flatMap((columnIndex) => {
      // A value too long for the line is wrapped from its uncolored text.
      const lines =
        measureLinesWidth(row[columnIndex]) > availableValueWidth
          ? splitCellLines(options.measureBodyRows[rowIndex][columnIndex]).flatMap((line) =>
              wrapAtNameBreaks(line, availableValueWidth),
            )
          : splitCellLines(row[columnIndex]);

      if (lines.every((line) => line.trim().length === 0)) {
        return [];
      }

      const alignment = getColumnAlignment(options.columnKinds[columnIndex]);
      const label = alignCellLine(
        joinCellLines(options.headerCells[columnIndex]),
        labelWidth,
        'left',
      );

      return lines.map((line, lineIndex) => {
        const value = alignCellLine(line, measureWidth, alignment).trimEnd();
        return lineIndex === 0 ? `  ${label}  ${value}` : `${continuationIndent}${value}`;
      });
    });

    return [title, ...valueLines].join('\n');
  });

  return records.join('\n\n');
}

export function renderUnicodeTable(options: RenderUnicodeTableOptions): string {
  const bodyColumnCount = getMaxRowColumnCount(options.bodyRows, options.headerCells.length);
  const measureColumnCount = getMaxRowColumnCount(
    options.measureBodyRows,
    options.measureHeaderCells.length,
  );
  const columnCount = Math.max(
    options.headerCells.length,
    options.measureHeaderCells.length,
    bodyColumnCount,
    measureColumnCount,
  );
  const renderableRows = normalizeRenderableRows({
    rowMetas: options.rowMetas,
    bodyRows: options.bodyRows,
    measureBodyRows: options.measureBodyRows,
    columnCount,
  });
  // Cells past the declared kinds (ragged rows) are treated as text.
  const columnKinds = Array.from(
    { length: columnCount },
    (_, columnIndex): TableColumnKind => options.columnKinds[columnIndex] ?? 'text',
  );
  const normalizedHeaderRow = padRowToColumnCount([...options.headerCells], columnCount);
  const normalizedMeasureHeaderRow = padRowToColumnCount(
    [...options.measureHeaderCells],
    columnCount,
  );
  const measureRows = [
    normalizedMeasureHeaderRow,
    ...renderableRows.map((row) => row.measureBodyRow),
  ];
  const widths = computeColumnWidths(measureRows, {
    multilineColumnIndex: options.multilineColumnIndex,
    multilineColumnWidth: options.multilineColumnWidth,
  });
  const normalizedBodyRows = renderableRows.map((row) => row.bodyRow);
  const normalizedRowMetas = renderableRows.map((row) => row.rowMeta);

  if (
    options.terminalWidth !== undefined &&
    measureBoxedTableWidth(widths) > options.terminalWidth
  ) {
    return renderStackedRows({
      headerCells: normalizedHeaderRow,
      measureHeaderCells: normalizedMeasureHeaderRow,
      bodyRows: normalizedBodyRows,
      measureBodyRows: renderableRows.map((row) => row.measureBodyRow),
      titleColumnCount: options.stackedTitleColumnCount ?? options.multilineColumnIndex + 1,
      terminalWidth: options.terminalWidth,
      columnKinds,
    });
  }

  const outputLines: string[] = [];

  outputLines.push(
    buildBorderLine(widths, {
      left: '╭',
      join: '┬',
      right: '╮',
    }),
  );
  outputLines.push(
    ...toRenderableRowLines(normalizedHeaderRow, {
      widths,
      layout: options.layout,
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

  normalizedBodyRows.forEach((row, rowIndex) => {
    outputLines.push(
      ...toRenderableRowLines(row, {
        widths,
        layout: options.layout,
        columnKinds,
      }),
    );

    if (shouldDrawBodySeparator(rowIndex, normalizedRowMetas)) {
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
