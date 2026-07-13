import type { UsageReportRow } from '../domain/usage-report-row.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import {
  createEmptyEfficiencyOutcomeTotals,
  createEmptyEfficiencyUsageTotals,
  type EfficiencyDerivedMetrics,
  type EfficiencyOutcomeTotals,
  type EfficiencyRow,
  type EfficiencySourceRow,
  type EfficiencyUsageTotals,
} from './efficiency-row.js';
import { addUsd } from '../utils/usd-math.js';

export type AggregateEfficiencyOptions = {
  usageRows: UsageReportRow[];
  periodOutcomes: ReadonlyMap<string, EfficiencyOutcomeTotals>;
  bySource?: boolean;
};

type UsageTotalsByPeriod = {
  combined: Map<string, EfficiencyUsageTotals>;
  sources: Map<string, Map<string, EfficiencyUsageTotals>>;
};

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

function buildUsageTotalsByPeriod(usageRows: UsageReportRow[]): UsageTotalsByPeriod {
  const combinedByPeriod = new Map<string, EfficiencyUsageTotals>();
  const sourceByPeriod = new Map<string, Map<string, EfficiencyUsageTotals>>();

  for (const row of usageRows) {
    if (row.rowType === 'grand_total') {
      continue;
    }

    if (row.rowType === 'period_combined') {
      combinedByPeriod.set(row.periodKey, toUsageTotals(row));
      continue;
    }

    const periodSources =
      sourceByPeriod.get(row.periodKey) ?? new Map<string, EfficiencyUsageTotals>();
    sourceByPeriod.set(row.periodKey, periodSources);
    const existingSourceTotals =
      periodSources.get(row.source) ?? createEmptyEfficiencyUsageTotals();
    periodSources.set(row.source, addUsageTotals(existingSourceTotals, toUsageTotals(row)));
  }

  return {
    combined: combinedByPeriod,
    sources: sourceByPeriod,
  };
}

function sumSourceTotals(
  sourceTotals: ReadonlyMap<string, EfficiencyUsageTotals> | undefined,
): EfficiencyUsageTotals | undefined {
  if (!sourceTotals) {
    return undefined;
  }

  let totals = createEmptyEfficiencyUsageTotals();

  for (const source of sourceTotals.values()) {
    totals = addUsageTotals(totals, source);
  }

  return totals;
}

function resolveUsageTotalsByPeriod(
  usageTotals: UsageTotalsByPeriod,
): Map<string, EfficiencyUsageTotals> {
  const periodKeys = new Set<string>([
    ...usageTotals.combined.keys(),
    ...usageTotals.sources.keys(),
  ]);
  const usageTotalsByPeriod = new Map<string, EfficiencyUsageTotals>();

  for (const periodKey of periodKeys) {
    usageTotalsByPeriod.set(
      periodKey,
      usageTotals.combined.get(periodKey) ??
        sumSourceTotals(usageTotals.sources.get(periodKey)) ??
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
  const hasAnyBucketUsage = (value: EfficiencyUsageTotals): boolean =>
    value.inputTokens > 0 ||
    value.outputTokens > 0 ||
    value.reasoningTokens > 0 ||
    value.cacheReadTokens > 0 ||
    value.cacheWriteTokens > 0;
  const hasUnknownCost =
    (left.costIncomplete === true && left.costUsd === undefined) ||
    (right.costIncomplete === true && right.costUsd === undefined);
  const isNeutralZeroCost = (value: EfficiencyUsageTotals): boolean =>
    !hasAnyBucketUsage(value) &&
    value.totalTokens === 0 &&
    value.costUsd === 0 &&
    value.costIncomplete !== true;
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

function hasMeaningfulUsageSignal(usageTotals: EfficiencyUsageTotals): boolean {
  return (
    usageTotals.totalTokens > 0 ||
    usageTotals.inputTokens > 0 ||
    usageTotals.outputTokens > 0 ||
    usageTotals.reasoningTokens > 0 ||
    usageTotals.cacheReadTokens > 0 ||
    usageTotals.cacheWriteTokens > 0 ||
    usageTotals.costUsd !== undefined ||
    usageTotals.costIncomplete === true
  );
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

function computeCostShare(
  sourceTotals: EfficiencyUsageTotals,
  periodTotals: EfficiencyUsageTotals,
): number | undefined {
  if (sourceTotals.costUsd === undefined || periodTotals.costUsd === undefined) {
    return undefined;
  }

  if (periodTotals.costUsd === 0) {
    return sourceTotals.costUsd === 0 ? 0 : undefined;
  }

  return sourceTotals.costUsd / periodTotals.costUsd;
}

function buildSourceRows(
  periodKey: string,
  sourceTotals: ReadonlyMap<string, EfficiencyUsageTotals> | undefined,
  periodTotals: EfficiencyUsageTotals,
): EfficiencySourceRow[] {
  if (!sourceTotals) {
    return [];
  }

  return [...sourceTotals.entries()]
    .filter(([, totals]) => hasMeaningfulUsageSignal(totals))
    .map(([source, totals]) => ({
      rowType: 'period_source' as const,
      periodKey,
      source,
      ...totals,
      costShare: computeCostShare(totals, periodTotals),
    }));
}

export function aggregateEfficiency(options: AggregateEfficiencyOptions): EfficiencyRow[] {
  const usageTotalsBySource = buildUsageTotalsByPeriod(options.usageRows);
  const usageTotalsByPeriod = resolveUsageTotalsByPeriod(usageTotalsBySource);
  const periodKeys = [
    ...new Set([...usageTotalsByPeriod.keys(), ...options.periodOutcomes.keys()]),
  ].sort(compareByCodePoint);

  const rows: EfficiencyRow[] = [];
  let totalUsage = createEmptyEfficiencyUsageTotals();
  let totalOutcomes = createEmptyEfficiencyOutcomeTotals();

  for (const periodKey of periodKeys) {
    const periodUsageTotals =
      usageTotalsByPeriod.get(periodKey) ?? createEmptyEfficiencyUsageTotals();
    const outcomeTotals =
      options.periodOutcomes.get(periodKey) ?? createEmptyEfficiencyOutcomeTotals();
    const hasUsageRow = usageTotalsByPeriod.has(periodKey);
    const hasUsageSignal = hasUsageRow && hasMeaningfulUsageSignal(periodUsageTotals);

    if (outcomeTotals.commitCount === 0 || !hasUsageSignal) {
      continue;
    }

    if (options.bySource) {
      rows.push(
        ...buildSourceRows(
          periodKey,
          usageTotalsBySource.sources.get(periodKey),
          periodUsageTotals,
        ),
      );
    }

    const derived = computeDerivedMetrics(periodUsageTotals, outcomeTotals);

    rows.push({
      rowType: 'period',
      periodKey,
      ...periodUsageTotals,
      ...outcomeTotals,
      ...derived,
    });

    totalUsage = addUsageTotals(totalUsage, periodUsageTotals);
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
