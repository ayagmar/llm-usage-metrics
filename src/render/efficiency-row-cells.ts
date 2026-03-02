import type { EfficiencyRow } from '../efficiency/efficiency-row.js';

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

function formatInteger(value: number): string {
  return integerFormatter.format(value);
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

export function toEfficiencyTableCells(rows: EfficiencyRow[]): string[][] {
  return rows.map((row) => [
    row.periodKey,
    formatInteger(row.commitCount),
    formatInteger(row.linesAdded),
    formatInteger(row.linesDeleted),
    formatInteger(row.linesChanged),
    formatInteger(row.inputTokens),
    formatInteger(row.outputTokens),
    formatInteger(row.reasoningTokens),
    formatInteger(row.cacheReadTokens),
    formatInteger(row.cacheWriteTokens),
    formatInteger(row.totalTokens),
    formatUsd(row.costUsd, { approximate: row.costIncomplete }),
    formatUsdRate(row.usdPerCommit, { approximate: row.costIncomplete }),
    formatUsdRate(row.usdPer1kLinesChanged, { approximate: row.costIncomplete }),
    formatDecimal(row.tokensPerCommit),
    formatDecimal(row.commitsPerUsd, { approximate: row.costIncomplete }),
  ]);
}
