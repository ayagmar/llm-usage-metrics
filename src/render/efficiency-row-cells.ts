import type { EfficiencyRow } from '../efficiency/efficiency-row.js';
import { formatAbbreviatedTokenCount, formatApproxUsd, formatInteger } from './format-number.js';
import type { UsageTokenFormat } from './row-cells.js';

export const efficiencyTableHeaders = [
  'Period',
  'Commits',
  '+Lines',
  '-Lines',
  'Churn',
  'Input',
  'Output',
  'Reasoning',
  'Cache Read',
  'Cache Write',
  'Total',
  'Cost',
  '$/Commit',
  '$/1k Lines',
  'Tokens/Commit',
  'Commits/$',
] as const;

const decimalFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatOptionalInteger(value: number | undefined): string {
  return value === undefined ? '-' : formatInteger(value);
}

function formatDecimal(value: number | undefined, options: { approximate?: boolean } = {}): string {
  if (value === undefined) {
    return '-';
  }

  const formatted = decimalFormatter.format(value);
  return options.approximate ? `~${formatted}` : formatted;
}

/**
 * `abbreviated` shortens token counts (`1.43B`); commits, lines, and costs stay exact.
 * Tokens/Commit rounds to whole tokens.
 */
export function toEfficiencyTableCells(
  rows: EfficiencyRow[],
  tokenFormat: UsageTokenFormat = 'full',
): string[][] {
  const formatTokens =
    tokenFormat === 'abbreviated' ? formatAbbreviatedTokenCount : formatOptionalInteger;
  const formatTokenRate = (value: number | undefined) =>
    value === undefined ? '-' : formatTokens(Math.round(value));

  return rows.map((row) => [
    row.rowType === 'period_source' ? `  ${row.source}` : row.periodKey,
    formatOptionalInteger(row.rowType === 'period_source' ? undefined : row.commitCount),
    formatOptionalInteger(row.rowType === 'period_source' ? undefined : row.linesAdded),
    formatOptionalInteger(row.rowType === 'period_source' ? undefined : row.linesDeleted),
    formatOptionalInteger(row.rowType === 'period_source' ? undefined : row.linesChanged),
    formatTokens(row.inputTokens),
    formatTokens(row.outputTokens),
    formatTokens(row.reasoningTokens),
    formatTokens(row.cacheReadTokens),
    formatTokens(row.cacheWriteTokens),
    formatTokens(row.totalTokens),
    formatApproxUsd(row.costUsd, row.costIncomplete),
    formatApproxUsd(
      row.rowType === 'period_source' ? undefined : row.usdPerCommit,
      row.costIncomplete,
    ),
    formatApproxUsd(
      row.rowType === 'period_source' ? undefined : row.usdPer1kLinesChanged,
      row.costIncomplete,
    ),
    formatTokenRate(row.rowType === 'period_source' ? undefined : row.tokensPerCommit),
    formatDecimal(row.rowType === 'period_source' ? undefined : row.commitsPerUsd, {
      approximate: row.costIncomplete,
    }),
  ]);
}
