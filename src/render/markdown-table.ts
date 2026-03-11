import { markdownTable } from 'markdown-table';

import type { UsageReportRow } from '../domain/usage-report-row.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { toUsageTableCells, type UsageTableLayout, usageTableHeaders } from './row-cells.js';
import { splitCellLines } from './table-text-layout.js';

const alignment: ('l' | 'r')[] = ['l', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r'];

type MarkdownRenderOptions = {
  tableLayout?: UsageTableLayout;
};

function boldMarkdownText(value: string): string {
  const safeValue = toMarkdownSafeCell(value);
  return safeValue.length === 0 ? safeValue : `**${safeValue}**`;
}

function emphasizeMarkdownModelsCell(value: string): string {
  const lines = splitCellLines(value);

  return lines
    .map((line, index) => {
      if (line.length === 0) {
        return '';
      }

      if (line === 'Σ TOTAL') {
        return boldMarkdownText(line);
      }

      if (index === 0 && lines.length > 1) {
        return boldMarkdownText(line);
      }

      return toMarkdownSafeCell(line);
    })
    .join('<br>');
}

function emphasizeMarkdownSummaryMetricCell(value: string): string {
  const lines = splitCellLines(value);

  if (lines.length <= 1) {
    return boldMarkdownText(value);
  }

  return lines
    .map((line, index) =>
      index === lines.length - 1 ? boldMarkdownText(line) : toMarkdownSafeCell(line),
    )
    .join('<br>');
}

function emphasizeMarkdownRow(row: UsageReportRow, cells: string[]): string[] {
  const styledCells = cells.map((cell) => toMarkdownSafeCell(cell));

  if (styledCells.length > 2) {
    styledCells[2] = emphasizeMarkdownModelsCell(cells[2]);
  }

  if (row.rowType !== 'period_source') {
    if (styledCells.length > 1) {
      styledCells[1] = boldMarkdownText(cells[1]);
    }

    if (styledCells.length > 8) {
      styledCells[8] = emphasizeMarkdownSummaryMetricCell(cells[8]);
    }

    if (styledCells.length > 9) {
      styledCells[9] = emphasizeMarkdownSummaryMetricCell(cells[9]);
    }
  }

  if (row.rowType === 'grand_total' && styledCells.length > 0) {
    styledCells[0] = boldMarkdownText(cells[0]);
  }

  return styledCells;
}
export function renderMarkdownTable(
  rows: UsageReportRow[],
  options: MarkdownRenderOptions = {},
): string {
  const tableLayout = options.tableLayout ?? 'compact';
  const bodyRows = toUsageTableCells(rows, { layout: tableLayout }).map((cells, index) =>
    emphasizeMarkdownRow(rows[index], cells),
  );
  const tableRows = [Array.from(usageTableHeaders), ...bodyRows];

  return markdownTable(tableRows, {
    align: alignment,
  });
}
