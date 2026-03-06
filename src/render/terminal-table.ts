import pc from 'picocolors';

import type { UsageReportRow } from '../domain/usage-report-row.js';
import { colorizeUsageBodyRows } from './terminal-style-policy.js';
import { toUsageTableCells, type UsageTableLayout, usageTableHeaders } from './row-cells.js';
import { resolveTtyColumns, visibleWidth, wrapTableColumn } from './table-text-layout.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';

const modelsColumnIndex = 2;
const defaultModelsColumnWidth = 32;
const minimumModelsColumnWidth = 12;

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

  return headerCells.map((header) => pc.bold(pc.white(header)));
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

function renderTableWithModelsWidth(
  rows: UsageReportRow[],
  tableLayout: UsageTableLayout,
  useColor: boolean,
  modelsColumnWidth: number,
): string {
  const uncoloredBodyRows = toUsageTableCells(rows, { layout: tableLayout });
  const wrappedBodyRows = wrapTableColumn(uncoloredBodyRows, {
    columnIndex: modelsColumnIndex,
    width: modelsColumnWidth,
  });
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
  let modelsColumnWidth = defaultModelsColumnWidth;
  let renderedTable = renderTableWithModelsWidth(rows, tableLayout, useColor, modelsColumnWidth);

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
      renderedTable = renderTableWithModelsWidth(rows, tableLayout, useColor, modelsColumnWidth);
      renderedTableWidth = measureTableWidth(renderedTable);
    }

    if (hasExplicitTerminalWidth && renderedTableWidth > terminalWidth) {
      throw new Error(
        `Configured terminal width (${terminalWidth}) is too narrow for table rendering (minimum ${renderedTableWidth}).`,
      );
    }
  }

  return renderedTable;
}
