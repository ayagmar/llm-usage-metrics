import { markdownTable } from 'markdown-table';
import pc from 'picocolors';

import type { OptimizeDataResult } from '../cli/usage-data-contracts.js';
import type { OptimizeBaselineRow, OptimizeCandidateRow } from '../optimize/optimize-row.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { visibleWidth } from './table-text-layout.js';
import { renderReportHeader } from './report-header.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';

export type OptimizeReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderOptimizeReportOptions = {
  granularity: ReportGranularity;
  useColor?: boolean;
};

const optimizeTableHeadersWithNotes = [
  'Period',
  'Candidate',
  'Hypothetical Cost',
  'Baseline Cost',
  'Savings',
  'Savings %',
  'Notes',
] as const;

const optimizeTableHeadersWithoutNotes = [
  'Period',
  'Candidate',
  'Hypothetical Cost',
  'Baseline Cost',
  'Savings',
  'Savings %',
] as const;

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function getReportTitle(granularity: ReportGranularity): string {
  switch (granularity) {
    case 'daily':
      return 'Daily Optimize Report';
    case 'weekly':
      return 'Weekly Optimize Report';
    case 'monthly':
      return 'Monthly Optimize Report';
  }
}

function formatUsd(value: number | undefined, options: { approximate?: boolean } = {}): string {
  if (value === undefined) {
    return '-';
  }

  const formatted = usdFormatter.format(value);
  return options.approximate ? `~${formatted}` : formatted;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) {
    return '-';
  }

  return `${(value * 100).toFixed(2)}%`;
}

function formatNotes(notes: string[] | undefined): string {
  if (!notes || notes.length === 0) {
    return '-';
  }

  return notes.join(', ');
}

function styleCandidateCell(
  candidateValue: string,
  rowType: 'baseline' | 'candidate',
  useColor: boolean,
): string {
  if (!useColor) {
    return candidateValue;
  }

  if (rowType === 'baseline') {
    return pc.bold(pc.cyan(candidateValue));
  }

  return pc.bold(candidateValue);
}

function styleDeltaCell(
  value: number | undefined,
  formattedValue: string,
  useColor: boolean,
): string {
  if (!useColor || value === undefined) {
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

function styleNotesCell(
  notes: string[] | undefined,
  formattedNotes: string,
  useColor: boolean,
): string {
  if (!useColor || !notes || notes.length === 0) {
    return formattedNotes;
  }

  return pc.yellow(formattedNotes);
}

function formatAbsoluteUsd(value: number): string {
  return usdFormatter.format(Math.abs(value));
}

function resolveTerminalContextLines(
  optimizeData: OptimizeDataResult,
  options: { useColor: boolean },
): string[] {
  const allBaselineRow = optimizeData.rows.find(
    (row): row is OptimizeBaselineRow => row.rowType === 'baseline' && row.periodKey === 'ALL',
  );
  const allCandidateRows = optimizeData.rows.filter(
    (row): row is OptimizeCandidateRow => row.rowType === 'candidate' && row.periodKey === 'ALL',
  );
  const lines: string[] = [];

  const providerLine = `Provider scope: ${optimizeData.diagnostics.provider}`;
  lines.push(options.useColor ? pc.cyan(providerLine) : providerLine);

  if (allBaselineRow) {
    lines.push(
      `ALL baseline cost: ${formatUsd(allBaselineRow.baselineCostUsd, { approximate: allBaselineRow.baselineCostIncomplete })}`,
    );
  }

  if (allCandidateRows.length > 0) {
    const rowsWithSavings = allCandidateRows.filter((row) => row.savingsUsd !== undefined);
    const bestRow =
      rowsWithSavings.length > 0
        ? rowsWithSavings.reduce((best, current) =>
            (current.savingsUsd ?? Number.NEGATIVE_INFINITY) >
            (best.savingsUsd ?? Number.NEGATIVE_INFINITY)
              ? current
              : best,
          )
        : undefined;

    if (bestRow?.savingsUsd === undefined) {
      lines.push('ALL best candidate: unavailable (missing baseline or candidate pricing)');
    } else if (bestRow.savingsUsd > 0) {
      lines.push(
        `ALL best candidate: ${bestRow.candidateModel} saves ${formatAbsoluteUsd(bestRow.savingsUsd)} (${formatPercent(bestRow.savingsPct)})`,
      );
    } else if (bestRow.savingsUsd < 0) {
      lines.push(
        `ALL best candidate: ${bestRow.candidateModel} increases cost by ${formatAbsoluteUsd(bestRow.savingsUsd)} (${formatPercent(bestRow.savingsPct)})`,
      );
    } else {
      lines.push(`ALL best candidate: ${bestRow.candidateModel} matches baseline cost`);
    }
  }

  if (optimizeData.diagnostics.candidatesWithMissingPricing.length > 0) {
    const missingLine = `Missing candidate pricing: ${optimizeData.diagnostics.candidatesWithMissingPricing.join(', ')}`;
    lines.push(options.useColor ? pc.yellow(missingLine) : missingLine);
  }

  const legendLine = 'Savings = Baseline - Hypothetical (positive means cheaper candidate)';
  lines.push(options.useColor ? pc.dim(legendLine) : legendLine);

  return lines;
}

function toTableCells(
  optimizeData: OptimizeDataResult,
  options: { useColor: boolean; includeNotesColumn: boolean },
): string[][] {
  const baselineByPeriod = new Map(
    optimizeData.rows
      .filter((row) => row.rowType === 'baseline')
      .map((row) => [row.periodKey, row]),
  );

  return optimizeData.rows.map((row) => {
    const baselineRow = baselineByPeriod.get(row.periodKey);
    const periodCell =
      options.useColor && row.periodKey === 'ALL' ? pc.bold(row.periodKey) : row.periodKey;

    if (row.rowType === 'baseline') {
      const baselineCells = [
        periodCell,
        styleCandidateCell('BASELINE', 'baseline', options.useColor),
        '-',
        formatUsd(row.baselineCostUsd, { approximate: row.baselineCostIncomplete }),
        '-',
        '-',
      ];

      return options.includeNotesColumn ? [...baselineCells, '-'] : baselineCells;
    }

    const savingsCell = formatUsd(row.savingsUsd);
    const savingsPctCell = formatPercent(row.savingsPct);
    const notesCell = formatNotes(row.notes);

    const candidateCells = [
      periodCell,
      styleCandidateCell(row.candidateModel, 'candidate', options.useColor),
      formatUsd(row.hypotheticalCostUsd, { approximate: row.hypotheticalCostIncomplete }),
      formatUsd(baselineRow?.baselineCostUsd, {
        approximate: baselineRow?.baselineCostIncomplete === true,
      }),
      styleDeltaCell(row.savingsUsd, savingsCell, options.useColor),
      styleDeltaCell(row.savingsPct, savingsPctCell, options.useColor),
    ];

    return options.includeNotesColumn
      ? [...candidateCells, styleNotesCell(row.notes, notesCell, options.useColor)]
      : candidateCells;
  });
}

function toTableRowMeta(row: OptimizeDataResult['rows'][number]): TableRowMeta {
  return {
    periodKey: row.periodKey,
    periodGroup: 'normal',
    rowKind: 'detail',
  };
}

function resolveCandidateColumnWidth(tableCells: string[][]): number {
  return tableCells.reduce((maxWidth, row) => {
    const candidateValue = row[1] ?? '';
    return Math.max(maxWidth, visibleWidth(candidateValue));
  }, visibleWidth(optimizeTableHeadersWithNotes[1]));
}

function resolveIncludeNotesColumn(optimizeData: OptimizeDataResult): boolean {
  return optimizeData.rows.some(
    (row) => row.rowType === 'candidate' && row.notes !== undefined && row.notes.length > 0,
  );
}

function renderTerminalOptimizeReport(
  optimizeData: OptimizeDataResult,
  options: RenderOptimizeReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const includeNotesColumn = resolveIncludeNotesColumn(optimizeData);
  const tableCells = toTableCells(optimizeData, { useColor, includeNotesColumn });
  const candidateColumnWidth = resolveCandidateColumnWidth(tableCells);
  const contextLines = resolveTerminalContextLines(optimizeData, { useColor });
  const headerCells = includeNotesColumn
    ? [...optimizeTableHeadersWithNotes]
    : [...optimizeTableHeadersWithoutNotes];
  const outputLines: string[] = [];

  outputLines.push(
    renderReportHeader({
      title: getReportTitle(options.granularity),
      useColor,
    }),
  );
  outputLines.push('');
  outputLines.push(...contextLines);
  outputLines.push('');
  outputLines.push(
    renderUnicodeTable({
      headerCells,
      bodyRows: tableCells,
      measureHeaderCells: headerCells,
      measureBodyRows: tableCells,
      rowMetas: optimizeData.rows.map((row) => toTableRowMeta(row)),
      layout: 'compact',
      multilineColumnIndex: 1,
      multilineColumnWidth: candidateColumnWidth,
    }),
  );

  return outputLines.join('\n');
}

function renderMarkdownOptimizeReport(optimizeData: OptimizeDataResult): string {
  const includeNotesColumn = resolveIncludeNotesColumn(optimizeData);
  const headerCells = includeNotesColumn
    ? [...optimizeTableHeadersWithNotes]
    : [...optimizeTableHeadersWithoutNotes];
  const bodyRows = toTableCells(optimizeData, {
    useColor: false,
    includeNotesColumn,
  }).map((row) => row.map((cell) => toMarkdownSafeCell(cell)));
  const tableRows = [headerCells, ...bodyRows];
  const alignment = headerCells.map((_, index) => (index <= 1 ? 'l' : 'r')) as ('l' | 'r')[];

  return markdownTable(tableRows, { align: alignment });
}

export function renderOptimizeReport(
  optimizeData: OptimizeDataResult,
  format: OptimizeReportFormat,
  options: RenderOptimizeReportOptions,
): string {
  switch (format) {
    case 'json':
      return JSON.stringify(optimizeData.rows, null, 2);
    case 'markdown':
      return renderMarkdownOptimizeReport(optimizeData);
    case 'terminal':
      return renderTerminalOptimizeReport(optimizeData, options);
  }
}
