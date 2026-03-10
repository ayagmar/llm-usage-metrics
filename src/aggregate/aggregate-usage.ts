import type { UsageEvent } from '../domain/usage-event.js';
import type {
  GrandTotalRow,
  ModelUsageBreakdown,
  PeriodCombinedRow,
  PeriodSourceRow,
  UsageReportRow,
  UsageTotals,
} from '../domain/usage-report-row.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getPeriodKey, type ReportGranularity } from '../utils/time-buckets.js';

export type AggregateUsageOptions = {
  granularity: ReportGranularity;
  timezone: string;
  sourceOrder?: string[];
  includeModelBreakdown?: boolean;
};

type RowAccumulator = {
  totals: UsageTotals;
  modelTotals?: Map<string, UsageTotals>;
};

type RankedModelUsage = {
  models: string[];
  modelBreakdown: ModelUsageBreakdown[];
};

const USD_PRECISION_SCALE = 1_000_000_000_000;

function addUsd(left: number, right: number): number {
  return Math.round((left + right) * USD_PRECISION_SCALE) / USD_PRECISION_SCALE;
}

function createEmptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

function createRowAccumulator(includeModelBreakdown: boolean): RowAccumulator {
  return {
    totals: createEmptyTotals(),
    modelTotals: includeModelBreakdown ? new Map<string, UsageTotals>() : undefined,
  };
}

function addEventToTotals(target: UsageTotals, event: UsageEvent): void {
  target.inputTokens += event.inputTokens;
  target.outputTokens += event.outputTokens;
  target.reasoningTokens += event.reasoningTokens;
  target.cacheReadTokens += event.cacheReadTokens;
  target.cacheWriteTokens += event.cacheWriteTokens;
  target.totalTokens += event.totalTokens;

  if (event.costUsd === undefined) {
    target.costIncomplete = true;
    return;
  }

  target.costUsd = addUsd(target.costUsd ?? 0, event.costUsd);
}

function normalizeModelKey(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }

  const normalized = model.trim().toLowerCase();
  return normalized || undefined;
}

function addEventToAccumulator(
  accumulator: RowAccumulator,
  event: UsageEvent,
  includeModelBreakdown: boolean,
): void {
  addEventToTotals(accumulator.totals, event);

  if (!includeModelBreakdown) {
    return;
  }

  if (!accumulator.modelTotals) {
    return;
  }

  const normalizedModel = normalizeModelKey(event.model);

  if (!normalizedModel) {
    return;
  }

  const existingTotals = accumulator.modelTotals.get(normalizedModel) ?? createEmptyTotals();
  addEventToTotals(existingTotals, event);
  accumulator.modelTotals.set(normalizedModel, existingTotals);
}

function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.totalTokens += source.totalTokens;

  if (source.costUsd !== undefined) {
    target.costUsd = addUsd(target.costUsd ?? 0, source.costUsd);
  }

  if (source.costIncomplete) {
    target.costIncomplete = true;
  }
}

function mergeModelTotals(
  targetModelTotals: Map<string, UsageTotals>,
  sourceModelTotals: ReadonlyMap<string, UsageTotals>,
): void {
  for (const [model, sourceTotals] of sourceModelTotals) {
    const targetTotals = targetModelTotals.get(model) ?? createEmptyTotals();
    addTotals(targetTotals, sourceTotals);
    targetModelTotals.set(model, targetTotals);
  }
}

function compareModelUsageBreakdown(left: ModelUsageBreakdown, right: ModelUsageBreakdown): number {
  if (left.totalTokens !== right.totalTokens) {
    return right.totalTokens - left.totalTokens;
  }

  const leftCost = left.costUsd ?? Number.NEGATIVE_INFINITY;
  const rightCost = right.costUsd ?? Number.NEGATIVE_INFINITY;

  if (leftCost !== rightCost) {
    return rightCost - leftCost;
  }

  if (left.inputTokens !== right.inputTokens) {
    return right.inputTokens - left.inputTokens;
  }

  return compareByCodePoint(left.model, right.model);
}

function toRankedModelUsage(modelTotals: ReadonlyMap<string, UsageTotals>): RankedModelUsage {
  const modelBreakdown = [...modelTotals.entries()]
    .map(([model, totals]) => ({
      model,
      ...totals,
    }))
    .sort(compareModelUsageBreakdown);

  return {
    models: modelBreakdown.map((modelUsage) => modelUsage.model),
    modelBreakdown,
  };
}

function sourceSortComparator(
  left: string,
  right: string,
  sourceWeightMap: ReadonlyMap<string, number>,
): number {
  const leftWeight = sourceWeightMap.get(left) ?? Number.MAX_SAFE_INTEGER;
  const rightWeight = sourceWeightMap.get(right) ?? Number.MAX_SAFE_INTEGER;

  if (leftWeight !== rightWeight) {
    return leftWeight - rightWeight;
  }

  return compareByCodePoint(left, right);
}

export function aggregateUsage(
  events: UsageEvent[],
  options: AggregateUsageOptions,
): UsageReportRow[] {
  const includeModelBreakdown = options.includeModelBreakdown ?? true;
  const sourceWeightMap = new Map<string, number>();

  for (const [index, source] of (options.sourceOrder ?? []).entries()) {
    sourceWeightMap.set(source, index);
  }

  const periodMap = new Map<string, Map<string, RowAccumulator>>();

  for (const event of events) {
    const periodKey = getPeriodKey(event.timestamp, options.granularity, options.timezone);
    const periodSources = periodMap.get(periodKey) ?? new Map<string, RowAccumulator>();
    periodMap.set(periodKey, periodSources);

    const rowAccumulator =
      periodSources.get(event.source) ?? createRowAccumulator(includeModelBreakdown);
    periodSources.set(event.source, rowAccumulator);

    addEventToAccumulator(rowAccumulator, event, includeModelBreakdown);
  }

  const sortedPeriodKeys = [...periodMap.keys()].sort(compareByCodePoint);
  const rows: UsageReportRow[] = [];
  const grandTotals = createEmptyTotals();
  const grandModelTotals = new Map<string, UsageTotals>();

  for (const periodKey of sortedPeriodKeys) {
    const sourceMap = periodMap.get(periodKey);

    if (!sourceMap) {
      continue;
    }

    const periodCombinedTotals = createEmptyTotals();
    const periodCombinedModelTotals = new Map<string, UsageTotals>();

    const sortedSources = [...sourceMap.keys()].sort((left, right) =>
      sourceSortComparator(left, right, sourceWeightMap),
    );

    for (const source of sortedSources) {
      const accumulator = sourceMap.get(source);

      if (!accumulator) {
        continue;
      }

      const rankedModelUsage =
        includeModelBreakdown && accumulator.modelTotals
          ? toRankedModelUsage(accumulator.modelTotals)
          : { models: [], modelBreakdown: [] };

      const sourceRow: PeriodSourceRow = {
        rowType: 'period_source',
        periodKey,
        source,
        models: rankedModelUsage.models,
        modelBreakdown: rankedModelUsage.modelBreakdown,
        ...accumulator.totals,
      };

      rows.push(sourceRow);

      addTotals(periodCombinedTotals, accumulator.totals);
      addTotals(grandTotals, accumulator.totals);
      if (includeModelBreakdown && accumulator.modelTotals) {
        mergeModelTotals(periodCombinedModelTotals, accumulator.modelTotals);
        mergeModelTotals(grandModelTotals, accumulator.modelTotals);
      }
    }

    if (sortedSources.length > 1) {
      const rankedCombinedModels = includeModelBreakdown
        ? toRankedModelUsage(periodCombinedModelTotals)
        : { models: [], modelBreakdown: [] };
      const combinedRow: PeriodCombinedRow = {
        rowType: 'period_combined',
        periodKey,
        source: 'combined',
        models: rankedCombinedModels.models,
        modelBreakdown: rankedCombinedModels.modelBreakdown,
        ...periodCombinedTotals,
      };

      rows.push(combinedRow);
    }
  }

  const finalizedGrandTotals =
    events.length === 0 && grandTotals.costUsd === undefined && grandTotals.costIncomplete !== true
      ? { ...grandTotals, costUsd: 0 }
      : grandTotals;

  const rankedGrandModels = includeModelBreakdown
    ? toRankedModelUsage(grandModelTotals)
    : { models: [], modelBreakdown: [] };
  const grandTotalRow: GrandTotalRow = {
    rowType: 'grand_total',
    periodKey: 'ALL',
    source: 'combined',
    models: rankedGrandModels.models,
    modelBreakdown: rankedGrandModels.modelBreakdown,
    ...finalizedGrandTotals,
  };

  rows.push(grandTotalRow);

  return rows;
}
