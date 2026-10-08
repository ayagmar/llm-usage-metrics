import type { ModelUsageBreakdown, UsageReportRow } from '../domain/usage-report-row.js';

export type UsageTableLayout = 'compact' | 'per_model_columns';

/** `abbreviated` renders token counts as `1.09M`, `616M`, `24.3K`; cost stays exact. */
export type UsageTokenFormat = 'full' | 'abbreviated';

const usageTableColumnIds = [
  'period',
  'source',
  'models',
  'input',
  'output',
  'reasoning',
  'cacheRead',
  'cacheWrite',
  'total',
  'cost',
] as const;

export type UsageTableColumnId = (typeof usageTableColumnIds)[number];

export const usageTableHeaders = [
  'Period',
  'Source',
  'Models',
  'Input',
  'Output',
  'Reasoning',
  'Cache Read',
  'Cache Write',
  'Total',
  'Cost',
] as const;

/** Columns `--compact` leaves out of terminal and markdown tables. */
export const compactHiddenUsageColumns: readonly UsageTableColumnId[] = ['reasoning', 'cacheWrite'];

export function getUsageTableHeader(columnId: UsageTableColumnId): string {
  return usageTableHeaders[usageTableColumnIds.indexOf(columnId)];
}

/** Indexes of the columns that stay visible, in table order. */
export function getVisibleUsageColumnIndexes(
  hiddenColumns: ReadonlySet<UsageTableColumnId>,
): number[] {
  return usageTableColumnIds.flatMap((columnId, index) =>
    hiddenColumns.has(columnId) ? [] : [index],
  );
}

export function selectColumns<T>(cells: readonly T[], columnIndexes: readonly number[]): T[] {
  return columnIndexes.map((columnIndex) => cells[columnIndex]);
}

const integerFormatter = new Intl.NumberFormat('en-US');
const abbreviatedIntegerFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumSignificantDigits: 3,
});
const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatSource(row: UsageReportRow): string {
  if (row.rowType === 'grand_total') {
    return 'TOTAL';
  }

  return row.rowType === 'period_source' && row.machine !== undefined
    ? `${row.source} (${row.machine})`
    : row.source;
}

function formatFullTokenCount(value: number | undefined): string {
  return integerFormatter.format(value ?? 0);
}

function formatAbbreviatedTokenCount(value: number | undefined): string {
  return abbreviatedIntegerFormatter.format(value ?? 0);
}

function formatUsd(value: number | undefined, options: { incomplete?: boolean } = {}): string {
  if (value === undefined) {
    return '-';
  }

  const formattedUsd = usdFormatter.format(value);
  return options.incomplete ? `~${formattedUsd}` : formattedUsd;
}

function buildModelLines(row: UsageReportRow): string[] {
  if (row.modelBreakdown.length > 0) {
    return row.modelBreakdown.map((modelUsage) => `• ${modelUsage.model}`);
  }

  return row.models.map((model) => `• ${model}`);
}

function formatModels(row: UsageReportRow, layout: UsageTableLayout): string {
  const modelLines = buildModelLines(row);

  if (modelLines.length === 0) {
    return '-';
  }

  if (layout === 'per_model_columns' && row.modelBreakdown.length > 1) {
    return [...modelLines, 'Σ TOTAL'].join('\n');
  }

  return modelLines.join('\n');
}

function formatModelMetric(
  row: UsageReportRow,
  selector: (value: ModelUsageBreakdown | UsageReportRow) => number | undefined,
  formatter: (value: number | undefined) => string,
  layout: UsageTableLayout,
): string {
  if (layout !== 'per_model_columns' || row.modelBreakdown.length === 0) {
    return formatter(selector(row));
  }

  const lines = row.modelBreakdown.map((modelUsage) => formatter(selector(modelUsage)));

  if (row.modelBreakdown.length > 1) {
    lines.push(formatter(selector(row)));
  }

  return lines.join('\n');
}

function formatModelCostMetric(row: UsageReportRow, layout: UsageTableLayout): string {
  if (layout !== 'per_model_columns' || row.modelBreakdown.length === 0) {
    return formatUsd(row.costUsd, { incomplete: row.costIncomplete });
  }

  const lines = row.modelBreakdown.map((modelUsage) =>
    formatUsd(modelUsage.costUsd, { incomplete: modelUsage.costIncomplete }),
  );

  if (row.modelBreakdown.length > 1) {
    lines.push(formatUsd(row.costUsd, { incomplete: row.costIncomplete }));
  }

  return lines.join('\n');
}

export function toUsageTableCells(
  rows: UsageReportRow[],
  options: { layout?: UsageTableLayout; tokenFormat?: UsageTokenFormat } = {},
): string[][] {
  const layout = options.layout ?? 'compact';
  const formatTokenCount =
    options.tokenFormat === 'abbreviated' ? formatAbbreviatedTokenCount : formatFullTokenCount;

  return rows.map((row) => [
    row.periodKey,
    formatSource(row),
    formatModels(row, layout),
    formatModelMetric(row, (value) => value.inputTokens, formatTokenCount, layout),
    formatModelMetric(row, (value) => value.outputTokens, formatTokenCount, layout),
    formatModelMetric(row, (value) => value.reasoningTokens, formatTokenCount, layout),
    formatModelMetric(row, (value) => value.cacheReadTokens, formatTokenCount, layout),
    formatModelMetric(row, (value) => value.cacheWriteTokens, formatTokenCount, layout),
    formatModelMetric(row, (value) => value.totalTokens, formatTokenCount, layout),
    formatModelCostMetric(row, layout),
  ]);
}
