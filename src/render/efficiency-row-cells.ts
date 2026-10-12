import type { EfficiencyRow } from '../efficiency/efficiency-row.js';
import { formatAbbreviatedTokenCount, type UsageTokenFormat } from './row-cells.js';

export const efficiencyTableHeaders = [
  'Period',
  'Commits',
  '+Lines',
  '-Lines',
  'ΔLines',
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

const integerFormatter = new Intl.NumberFormat('en-US');
const decimalFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdRateFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

function formatInteger(value: number | undefined): string {
  return value === undefined ? '-' : integerFormatter.format(value);
}

function formatUsd(value: number | undefined, options: { approximate?: boolean } = {}): string {
  if (value === undefined) {
    return '-';
  }

  const formatted = usdFormatter.format(value);
  return options.approximate ? `~${formatted}` : formatted;
}

function formatUsdRate(value: number | undefined, options: { approximate?: boolean } = {}): string {
  if (value === undefined) {
    return '-';
  }

  const formatted = usdRateFormatter.format(value);
  return options.approximate ? `~${formatted}` : formatted;
}

function formatDecimal(value: number | undefined, options: { approximate?: boolean } = {}): string {
  if (value === undefined) {
    return '-';
  }

  const formatted = decimalFormatter.format(value);
  return options.approximate ? `~${formatted}` : formatted;
}

/** `abbreviated` shortens token counts (`1.43B`); commits, lines, and costs stay exact. */
export function toEfficiencyTableCells(
  rows: EfficiencyRow[],
  tokenFormat: UsageTokenFormat = 'full',
): string[][] {
  const formatTokens = tokenFormat === 'abbreviated' ? formatAbbreviatedTokenCount : formatInteger;
  const formatTokenRate = (value: number | undefined) =>
    value !== undefined && tokenFormat === 'abbreviated'
      ? formatAbbreviatedTokenCount(value)
      : formatDecimal(value);

  return rows.map((row) => [
    row.rowType === 'period_source' ? `  ${row.source}` : row.periodKey,
    formatInteger(row.rowType === 'period_source' ? undefined : row.commitCount),
    formatInteger(row.rowType === 'period_source' ? undefined : row.linesAdded),
    formatInteger(row.rowType === 'period_source' ? undefined : row.linesDeleted),
    formatInteger(row.rowType === 'period_source' ? undefined : row.linesChanged),
    formatTokens(row.inputTokens),
    formatTokens(row.outputTokens),
    formatTokens(row.reasoningTokens),
    formatTokens(row.cacheReadTokens),
    formatTokens(row.cacheWriteTokens),
    formatTokens(row.totalTokens),
    formatUsd(row.costUsd, { approximate: row.costIncomplete }),
    formatUsdRate(row.rowType === 'period_source' ? undefined : row.usdPerCommit, {
      approximate: row.costIncomplete,
    }),
    formatUsdRate(row.rowType === 'period_source' ? undefined : row.usdPer1kLinesChanged, {
      approximate: row.costIncomplete,
    }),
    formatTokenRate(row.rowType === 'period_source' ? undefined : row.tokensPerCommit),
    formatDecimal(row.rowType === 'period_source' ? undefined : row.commitsPerUsd, {
      approximate: row.costIncomplete,
    }),
  ]);
}
