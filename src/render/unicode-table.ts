import { splitCellLines, visibleWidth } from './table-text-layout.js';

type TableAlignment = 'left' | 'right';
type TableVerticalAlignment = 'top' | 'middle';

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
  multilineColumnIndex: number;
  multilineColumnWidth: number;
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

function getColumnAlignment(columnIndex: number, multilineColumnIndex: number): TableAlignment {
  if (columnIndex <= multilineColumnIndex) {
    return 'left';
  }

  return 'right';
}

function getVerticalAlignment(
  columnIndex: number,
  layout: UnicodeTableLayout,
  multilineColumnIndex: number,
): TableVerticalAlignment {
  if (columnIndex <= multilineColumnIndex) {
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
    multilineColumnIndex: number;
  },
): string[] {
  const cellLines = row.map((cell) => splitCellLines(cell));
  const rowHeight = cellLines.reduce((max, lines) => Math.max(max, lines.length), 1);

  const paddedAlignedColumns = cellLines.map((lines, columnIndex) => {
    const verticalAlignment = getVerticalAlignment(
      columnIndex,
      options.layout,
      options.multilineColumnIndex,
    );
    const alignedLines = padCellLines(lines, rowHeight, verticalAlignment);
    const horizontalAlignment = getColumnAlignment(columnIndex, options.multilineColumnIndex);

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
  options: { multilineColumnIndex: number; multilineColumnWidth: number },
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

  widths[options.multilineColumnIndex] = options.multilineColumnWidth;

  return widths;
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
      multilineColumnIndex: options.multilineColumnIndex,
    }),
  );
  outputLines.push(
    buildBorderLine(widths, {
      left: '├',
      join: '┼',
      right: '┤',
    }),
  );

  const normalizedBodyRows = renderableRows.map((row) => row.bodyRow);
  const normalizedRowMetas = renderableRows.map((row) => row.rowMeta);

  normalizedBodyRows.forEach((row, rowIndex) => {
    outputLines.push(
      ...toRenderableRowLines(row, {
        widths,
        layout: options.layout,
        multilineColumnIndex: options.multilineColumnIndex,
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
