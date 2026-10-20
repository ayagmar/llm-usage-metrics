import { markdownTable } from 'markdown-table';
import pc from 'picocolors';

import type { OptimizeDataResult } from '../cli/usage-data-contracts.js';
import type {
  OptimizeBaselineRow,
  OptimizeCandidateRow,
  OptimizeRow,
} from '../optimize/optimize-row.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { formatApproxUsd, formatSharePercent, formatUsd } from './format-number.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { resolveTtyColumns, visibleWidth, wrapProse } from './table-text-layout.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import {
  createColorRoles,
  styleDeltaCell,
  type ColorRoles,
  type TextStyler,
} from './terminal-style-policy.js';
import { describeTableFit, type RenderedReportWithNotes } from './table-fit-note.js';
import { renderUnicodeTableWithFit, type TableRowMeta } from './unicode-table.js';
import { renderReportJson } from './report-json.js';

export type OptimizeReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderOptimizeReportOptions = {
  granularity: ReportGranularity;
  useColor?: boolean;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
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

const HYPOTHETICAL_COST_COLUMN_INDEX = 2;
// Note codes run long when several apply; on a terminal they wrap between codes to this width.
const NOTES_COLUMN_WIDTH = 28;

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

/** A signed ratio; one that rounds to zero prints without a sign. */
function formatPercent(value: number | undefined): string {
  const formatted = formatSharePercent(value ?? null);
  return formatted === '-0.0%' ? '0.0%' : formatted;
}

function formatNotes(notes: string[] | undefined): string {
  if (!notes || notes.length === 0) {
    return '-';
  }

  return notes.join(', ');
}

function styleLines(text: string, styler: TextStyler): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '' : styler(line)))
    .join('\n');
}

function formatAbsoluteUsd(value: number): string {
  return formatUsd(Math.abs(value));
}

/**
 * Wraps `label value` to the terminal width, then dims the label and styles the value.
 * Coloring after wrapping keeps escape codes out of the width.
 */
function renderLabeledLine(
  label: string,
  value: string,
  options: { roles: ColorRoles; terminalWidth: number | undefined; valueStyler?: TextStyler },
): string {
  const valueStyler = options.valueStyler ?? options.roles.value;
  const [firstLine, ...continuationLines] = wrapProse(
    `${label} ${value}`,
    options.terminalWidth,
  ).split('\n');

  return [
    options.roles.label(firstLine.slice(0, label.length)) +
      valueStyler(firstLine.slice(label.length)),
    ...continuationLines.map((line) => valueStyler(line)),
  ].join('\n');
}

function renderProviderLine(
  optimizeData: OptimizeDataResult,
  options: { roles: ColorRoles; terminalWidth: number | undefined },
): string {
  return renderLabeledLine('Provider scope:', optimizeData.diagnostics.provider, options);
}

function formatBestCandidate(bestRow: OptimizeCandidateRow | undefined): string {
  if (bestRow?.savingsUsd === undefined) {
    return 'unavailable (missing baseline or candidate pricing)';
  }

  if (bestRow.savingsUsd > 0) {
    return `${bestRow.candidateModel} saves ${formatAbsoluteUsd(bestRow.savingsUsd)} (${formatPercent(bestRow.savingsRatio)})`;
  }

  if (bestRow.savingsUsd < 0) {
    return `${bestRow.candidateModel} increases cost by ${formatAbsoluteUsd(bestRow.savingsUsd)} (${formatPercent(bestRow.savingsRatio)})`;
  }

  return `${bestRow.candidateModel} matches baseline cost`;
}

function resolveTerminalContextLines(
  optimizeData: OptimizeDataResult,
  options: { roles: ColorRoles; terminalWidth: number | undefined },
): string[] {
  const { roles, terminalWidth } = options;
  const allBaselineRow = optimizeData.rows.find(
    (row): row is OptimizeBaselineRow => row.rowType === 'baseline' && row.periodKey === 'ALL',
  );
  const allCandidateRows = optimizeData.rows.filter(
    (row): row is OptimizeCandidateRow => row.rowType === 'candidate' && row.periodKey === 'ALL',
  );
  const lines: string[] = [];

  lines.push(renderProviderLine(optimizeData, options));

  if (allBaselineRow) {
    lines.push(
      renderLabeledLine(
        'ALL baseline cost:',
        formatApproxUsd(allBaselineRow.baselineCostUsd, allBaselineRow.baselineCostIncomplete),
        { ...options, valueStyler: roles.moneyTotal },
      ),
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

    lines.push(renderLabeledLine('ALL best candidate:', formatBestCandidate(bestRow), options));
  }

  if (optimizeData.diagnostics.candidatesWithMissingPricing.length > 0) {
    const missingLine = `Missing candidate pricing: ${optimizeData.diagnostics.candidatesWithMissingPricing.join(', ')}`;
    lines.push(styleLines(wrapProse(missingLine, terminalWidth), roles.warning));
  }

  const legendLine = 'Savings = Baseline - Hypothetical (positive means cheaper candidate)';
  lines.push(styleLines(wrapProse(legendLine, terminalWidth), roles.dim));

  return lines;
}

function toTableCells(
  optimizeData: OptimizeDataResult,
  options: { useColor: boolean; includeNotesColumn: boolean; notesColumnWidth?: number },
): string[][] {
  const roles = createColorRoles(options.useColor);
  const totalKeyStyler: TextStyler = options.useColor ? pc.bold : (text) => text;
  const baselineByPeriod = new Map(
    optimizeData.rows
      .filter((row) => row.rowType === 'baseline')
      .map((row) => [row.periodKey, row]),
  );

  return optimizeData.rows.map((row) => {
    const isTotal = row.periodKey === 'ALL';
    const keyStyler = isTotal ? totalKeyStyler : roles.value;
    const moneyStyler = isTotal ? roles.moneyTotal : roles.money;
    const periodCell = keyStyler(row.periodKey);

    if (row.rowType === 'baseline') {
      const baselineCells = [
        periodCell,
        roles.dim('BASELINE'),
        '-',
        moneyStyler(formatApproxUsd(row.baselineCostUsd, row.baselineCostIncomplete)),
        '-',
        '-',
      ];

      return options.includeNotesColumn ? [...baselineCells, '-'] : baselineCells;
    }

    const baselineRow = baselineByPeriod.get(row.periodKey);
    const notesCell = wrapProse(formatNotes(row.notes), options.notesColumnWidth);
    const candidateCells = [
      periodCell,
      styleLines(row.candidateModel, keyStyler),
      moneyStyler(formatApproxUsd(row.hypotheticalCostUsd, row.hypotheticalCostIncomplete)),
      moneyStyler(
        formatApproxUsd(baselineRow?.baselineCostUsd, baselineRow?.baselineCostIncomplete === true),
      ),
      styleDeltaCell(row.savingsUsd, formatUsd(row.savingsUsd), options.useColor),
      styleDeltaCell(row.savingsRatio, formatPercent(row.savingsRatio), options.useColor),
    ];

    return options.includeNotesColumn
      ? [...candidateCells, row.notes?.length ? styleLines(notesCell, roles.warning) : notesCell]
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

function toCents(usd: number): number {
  return Math.round(usd * 100);
}

/**
 * Costs stay exact, so the table fits by leaving out Hypothetical Cost, and only when every
 * row still shows it to the cent as Baseline Cost minus Savings. Notes carry pricing caveats
 * found nowhere else, so they are never left out: the rows are listed instead.
 */
function resolveHideableColumns(optimizeData: OptimizeDataResult): number[] {
  const baselineByPeriod = new Map(
    optimizeData.rows
      .filter((row) => row.rowType === 'baseline')
      .map((row) => [row.periodKey, row.baselineCostUsd]),
  );
  const hypotheticalCostIsDerivable = optimizeData.rows.every((row) => {
    if (row.rowType === 'baseline' || row.hypotheticalCostUsd === undefined) {
      return true;
    }

    const baselineCostUsd = baselineByPeriod.get(row.periodKey);

    return (
      row.savingsUsd !== undefined &&
      baselineCostUsd !== undefined &&
      toCents(baselineCostUsd) - toCents(row.savingsUsd) === toCents(row.hypotheticalCostUsd)
    );
  });

  return hypotheticalCostIsDerivable ? [HYPOTHETICAL_COST_COLUMN_INDEX] : [];
}

/** As the optimize builder decides which periods have usage. */
function hasBaselineUsage(row: OptimizeRow): boolean {
  return (
    row.rowType === 'baseline' &&
    (row.totalTokens > 0 || row.baselineCostIncomplete || (row.baselineCostUsd ?? 0) > 0)
  );
}

function renderTerminalOptimizeReport(
  optimizeData: OptimizeDataResult,
  options: RenderOptimizeReportOptions,
): RenderedReportWithNotes {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const roles = createColorRoles(useColor);
  const terminalWidth = resolveTtyColumns(process.stdout);
  const header = renderReportHeader({
    title: getReportTitle(options.granularity),
    useColor,
    terminalWidth,
  });

  // No baseline tokens, logged cost or unpriced usage: the provider has nothing to compare.
  if (!optimizeData.rows.some(hasBaselineUsage)) {
    return {
      output: [
        header,
        '',
        renderProviderLine(optimizeData, { roles, terminalWidth }),
        '',
        wrapProse(formatNoUsageMessage(options.filtered ?? false), terminalWidth),
      ].join('\n'),
      notes: [],
    };
  }

  const includeNotesColumn = resolveIncludeNotesColumn(optimizeData);
  const cellOptions = {
    includeNotesColumn,
    notesColumnWidth: terminalWidth === undefined ? undefined : NOTES_COLUMN_WIDTH,
  };
  const tableCells = toTableCells(optimizeData, { ...cellOptions, useColor });
  const measureCells = toTableCells(optimizeData, { ...cellOptions, useColor: false });
  const headerCells = includeNotesColumn
    ? [...optimizeTableHeadersWithNotes]
    : [...optimizeTableHeadersWithoutNotes];

  const { output, fit } = renderUnicodeTableWithFit({
    headerCells: headerCells.map((cell) => roles.header(cell)),
    bodyRows: tableCells,
    measureHeaderCells: headerCells,
    measureBodyRows: measureCells,
    rowMetas: optimizeData.rows.map((row) => toTableRowMeta(row)),
    columnKinds: headerCells.map((cell, index) =>
      index <= 1 || cell === 'Notes' ? 'text' : 'measure',
    ),
    multilineColumnIndex: 1,
    multilineColumnWidth: resolveCandidateColumnWidth(measureCells),
    terminalWidth,
    fit: { hideableColumns: resolveHideableColumns(optimizeData) },
  });
  const fitNote = describeTableFit(fit);

  return {
    output: [
      header,
      '',
      ...resolveTerminalContextLines(optimizeData, { roles, terminalWidth }),
      '',
      output,
    ].join('\n'),
    notes: fitNote ? [fitNote] : [],
  };
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

  return [
    `Provider scope: ${toMarkdownSafeCell(optimizeData.diagnostics.provider)}`,
    '',
    markdownTable(tableRows, { align: alignment }),
  ].join('\n');
}

export function renderOptimizeReportWithNotes(
  optimizeData: OptimizeDataResult,
  format: OptimizeReportFormat,
  options: RenderOptimizeReportOptions,
): RenderedReportWithNotes {
  switch (format) {
    case 'json':
      return { output: renderReportJson('optimize', optimizeData.rows), notes: [] };
    case 'markdown':
      return { output: renderMarkdownOptimizeReport(optimizeData), notes: [] };
    case 'terminal':
      return renderTerminalOptimizeReport(optimizeData, options);
  }
}

export function renderOptimizeReport(
  optimizeData: OptimizeDataResult,
  format: OptimizeReportFormat,
  options: RenderOptimizeReportOptions,
): string {
  return renderOptimizeReportWithNotes(optimizeData, format, options).output;
}
