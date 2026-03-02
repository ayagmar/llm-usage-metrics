import type { UsageReportRow } from '../domain/usage-report-row.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import {
  createEmptyEfficiencyOutcomeTotals,
  createEmptyEfficiencyUsageTotals,
  type EfficiencyDerivedMetrics,
  type EfficiencyOutcomeTotals,
  type EfficiencyRow,
  type EfficiencyUsageTotals,
} from './efficiency-row.js';

const USD_PRECISION_SCALE = 1_000_000_000_000;

export type AggregateEfficiencyOptions = {
  usageRows: UsageReportRow[];
  periodOutcomes: ReadonlyMap<string, EfficiencyOutcomeTotals>;
};

function addUsd(left: number, right: number): number {
  return Math.round((left + right) * USD_PRECISION_SCALE) / USD_PRECISION_SCALE;
}

function toUsageTotals(row: UsageReportRow): EfficiencyUsageTotals {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
    costIncomplete: row.costIncomplete,
  };
}

function buildUsageTotalsByPeriod(usageRows: UsageReportRow[]): Map<string, EfficiencyUsageTotals> {
  const combinedByPeriod = new Map<string, EfficiencyUsageTotals>();
  const sourceByPeriod = new Map<string, EfficiencyUsageTotals>();

  for (const row of usageRows) {
    if (row.rowType === 'grand_total') {
      continue;
    }

    if (row.rowType === 'period_combined') {
      combinedByPeriod.set(row.periodKey, toUsageTotals(row));
      continue;
    }

    const existingSourceTotals =
      sourceByPeriod.get(row.periodKey) ?? createEmptyEfficiencyUsageTotals();
    sourceByPeriod.set(row.periodKey, addUsageTotals(existingSourceTotals, toUsageTotals(row)));
  }

  const periodKeys = new Set<string>([...combinedByPeriod.keys(), ...sourceByPeriod.keys()]);
  const usageTotalsByPeriod = new Map<string, EfficiencyUsageTotals>();

  for (const periodKey of periodKeys) {
    usageTotalsByPeriod.set(
      periodKey,
      combinedByPeriod.get(periodKey) ??
        sourceByPeriod.get(periodKey) ??
        createEmptyEfficiencyUsageTotals(),
    );
  }

  return usageTotalsByPeriod;
}

function addOutcomeTotals(
  left: EfficiencyOutcomeTotals,
  right: EfficiencyOutcomeTotals,
): EfficiencyOutcomeTotals {
  return {
    commitCount: left.commitCount + right.commitCount,
    linesAdded: left.linesAdded + right.linesAdded,
    linesDeleted: left.linesDeleted + right.linesDeleted,
    linesChanged: left.linesChanged + right.linesChanged,
  };
}

function addUsageTotals(
  left: EfficiencyUsageTotals,
  right: EfficiencyUsageTotals,
): EfficiencyUsageTotals {
  const hasUnknownCost =
    (left.costIncomplete === true && left.costUsd === undefined) ||
    (right.costIncomplete === true && right.costUsd === undefined);
  const isNeutralZeroCost = (value: EfficiencyUsageTotals): boolean =>
    value.totalTokens === 0 && value.costUsd === 0 && value.costIncomplete !== true;
  const leftKnownCost =
    left.costUsd !== undefined && !isNeutralZeroCost(left) ? left.costUsd : undefined;
  const rightKnownCost =
    right.costUsd !== undefined && !isNeutralZeroCost(right) ? right.costUsd : undefined;

  let costUsd =
    leftKnownCost !== undefined && rightKnownCost !== undefined
      ? addUsd(leftKnownCost, rightKnownCost)
      : (leftKnownCost ?? rightKnownCost);

  if (hasUnknownCost && (costUsd === undefined || costUsd === 0)) {
    costUsd = undefined;
  }

  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd,
    costIncomplete: left.costIncomplete || right.costIncomplete ? true : undefined,
  };
}

function computeDerivedMetrics(
  usage: EfficiencyUsageTotals,
  outcomes: EfficiencyOutcomeTotals,
): EfficiencyDerivedMetrics {
  const costUsd = usage.costUsd;
  const nonCacheTotalTokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens;

  return {
    usdPerCommit:
      costUsd !== undefined && outcomes.commitCount > 0
        ? costUsd / outcomes.commitCount
        : undefined,
    usdPer1kLinesChanged:
      costUsd !== undefined && outcomes.linesChanged > 0
        ? costUsd / (outcomes.linesChanged / 1_000)
        : undefined,
    tokensPerCommit:
      outcomes.commitCount > 0 ? nonCacheTotalTokens / outcomes.commitCount : undefined,
    commitsPerUsd:
      costUsd !== undefined && costUsd > 0 ? outcomes.commitCount / costUsd : undefined,
  };
}

export function aggregateEfficiency(options: AggregateEfficiencyOptions): EfficiencyRow[] {
  const usageTotalsByPeriod = buildUsageTotalsByPeriod(options.usageRows);
  const periodKeys = [
    ...new Set([...usageTotalsByPeriod.keys(), ...options.periodOutcomes.keys()]),
  ].sort(compareByCodePoint);

  const rows: EfficiencyRow[] = [];
  let totalUsage = createEmptyEfficiencyUsageTotals();
  let totalOutcomes = createEmptyEfficiencyOutcomeTotals();

  for (const periodKey of periodKeys) {
    const usageTotals = usageTotalsByPeriod.get(periodKey) ?? createEmptyEfficiencyUsageTotals();
    const outcomeTotals =
      options.periodOutcomes.get(periodKey) ?? createEmptyEfficiencyOutcomeTotals();
    const hasUsageRow = usageTotalsByPeriod.has(periodKey);
    const hasUsageSignal =
      hasUsageRow &&
      (usageTotals.totalTokens > 0 ||
        usageTotals.costUsd !== undefined ||
        usageTotals.costIncomplete === true);

    if (outcomeTotals.commitCount === 0 || !hasUsageSignal) {
      continue;
    }

    const derived = computeDerivedMetrics(usageTotals, outcomeTotals);

    rows.push({
      rowType: 'period',
      periodKey,
      ...usageTotals,
      ...outcomeTotals,
      ...derived,
    });

    totalUsage = addUsageTotals(totalUsage, usageTotals);
    totalOutcomes = addOutcomeTotals(totalOutcomes, outcomeTotals);
  }

  const finalizedTotalUsage =
    totalUsage.costUsd === undefined &&
    totalUsage.costIncomplete !== true &&
    totalUsage.totalTokens === 0
      ? { ...totalUsage, costUsd: 0 }
      : totalUsage;

  rows.push({
    rowType: 'grand_total',
    periodKey: 'ALL',
    ...finalizedTotalUsage,
    ...totalOutcomes,
    ...computeDerivedMetrics(finalizedTotalUsage, totalOutcomes),
  });

  return rows;
}
