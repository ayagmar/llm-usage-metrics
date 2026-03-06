import type { UsageReportRow } from '../domain/usage-report-row.js';
import { hasBillableTokenBuckets, type UsageEvent } from '../domain/usage-event.js';
import { calculateEstimatedCostUsd } from '../pricing/cost-engine.js';
import type { PricingSource } from '../pricing/types.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import type { OptimizeBaselineRow, OptimizeCandidateRow, OptimizeRow } from './optimize-row.js';

const USD_PRECISION_SCALE = 1_000_000_000_000;

type BaselinePeriodTotals = {
  periodKey: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  baselineCostUsd: number | undefined;
  baselineCostIncomplete: boolean;
};

type CandidateEvaluation = {
  candidateRow: OptimizeCandidateRow;
  missingPricing: boolean;
  hasBaselineTokenMismatch: boolean;
};

export type BuildCounterfactualRowsInput = {
  usageRows: UsageReportRow[];
  provider: string;
  candidateModels: string[];
  pricingSource?: PricingSource;
  top?: number;
};

export type BuildCounterfactualRowsResult = {
  rows: OptimizeRow[];
  candidatesWithMissingPricing: string[];
  baselineCostIncomplete: boolean;
  warning?: string;
};

export function roundUsd(value: number): number {
  return Math.round(value * USD_PRECISION_SCALE) / USD_PRECISION_SCALE;
}

function hasAnyUsageSignal(period: BaselinePeriodTotals): boolean {
  return (
    period.totalTokens > 0 || period.baselineCostIncomplete || (period.baselineCostUsd ?? 0) > 0
  );
}

function parseCandidateModelsRaw(candidateModel: string | string[] | undefined): string[] {
  if (!candidateModel || (Array.isArray(candidateModel) && candidateModel.length === 0)) {
    throw new Error('At least one --candidate-model is required');
  }

  const normalizedCandidates = (Array.isArray(candidateModel) ? candidateModel : [candidateModel])
    .flatMap((candidate) => candidate.split(','))
    .map((candidate) => candidate.trim().toLowerCase())
    .filter((candidate) => candidate.length > 0);

  if (normalizedCandidates.length === 0) {
    throw new Error('--candidate-model must contain at least one non-empty model name');
  }

  return [...new Set(normalizedCandidates)];
}

export function normalizeCandidateModels(candidateModel: string | string[] | undefined): string[] {
  return parseCandidateModelsRaw(candidateModel);
}

export function parseTopOption(top: string | undefined): number | undefined {
  if (top === undefined) {
    return undefined;
  }

  const normalized = top.trim();
  const parsed = Number.parseInt(normalized, 10);

  if (!/^\d+$/u.test(normalized) || Number.isNaN(parsed) || parsed < 1) {
    throw new Error('--top must be a positive integer');
  }

  return parsed;
}

function toBaselineRow(period: BaselinePeriodTotals, provider: string): OptimizeBaselineRow {
  return {
    rowType: 'baseline',
    periodKey: period.periodKey,
    provider,
    inputTokens: period.inputTokens,
    outputTokens: period.outputTokens,
    reasoningTokens: period.reasoningTokens,
    cacheReadTokens: period.cacheReadTokens,
    cacheWriteTokens: period.cacheWriteTokens,
    totalTokens: period.totalTokens,
    baselineCostUsd: period.baselineCostUsd,
    baselineCostIncomplete: period.baselineCostIncomplete,
  };
}

function createSyntheticEvent(period: BaselinePeriodTotals): UsageEvent {
  return {
    source: 'pi',
    sessionId: 'optimize-period',
    timestamp: '1970-01-01T00:00:00.000Z',
    provider: undefined,
    model: 'synthetic',
    inputTokens: period.inputTokens,
    outputTokens: period.outputTokens,
    reasoningTokens: period.reasoningTokens,
    cacheReadTokens: period.cacheReadTokens,
    cacheWriteTokens: period.cacheWriteTokens,
    totalTokens: period.totalTokens,
    costMode: 'estimated',
    costUsd: undefined,
  };
}

function withNotes(notes: Set<string>): string[] | undefined {
  if (notes.size === 0) {
    return undefined;
  }

  return [...notes].sort(compareByCodePoint);
}

function evaluateCandidateForPeriod(
  period: BaselinePeriodTotals,
  provider: string,
  candidateModel: string,
  pricingSource: PricingSource | undefined,
): CandidateEvaluation {
  const notes = new Set<string>();
  const hasBillableUsage = hasBillableTokenBuckets(period);

  const candidateResolvedModel = pricingSource
    ? pricingSource.resolveModelAlias(candidateModel)
    : candidateModel;
  const pricing = pricingSource ? pricingSource.getPricing(candidateResolvedModel) : undefined;

  let hypotheticalCostUsd: number | undefined;
  let hypotheticalCostIncomplete = false;

  if (!hasBillableUsage) {
    if (!hasAnyUsageSignal(period)) {
      hypotheticalCostUsd = 0;
    } else {
      hypotheticalCostUsd = undefined;
      hypotheticalCostIncomplete = true;
      notes.add('usage_buckets_missing');
    }
  } else if (!pricing) {
    hypotheticalCostUsd = undefined;
    hypotheticalCostIncomplete = true;
    notes.add('missing_pricing');
  } else {
    hypotheticalCostUsd = roundUsd(
      calculateEstimatedCostUsd(createSyntheticEvent(period), pricing),
    );
  }

  let savingsUsd: number | undefined;
  let savingsPct: number | undefined;
  let hasBaselineTokenMismatch = false;

  if (period.baselineCostIncomplete || period.baselineCostUsd === undefined) {
    notes.add('baseline_incomplete');
  } else if (!hasBillableUsage && period.baselineCostUsd > 0) {
    notes.add('baseline_tokens_missing');
    hasBaselineTokenMismatch = true;
  } else if (hypotheticalCostUsd !== undefined) {
    savingsUsd = roundUsd(period.baselineCostUsd - hypotheticalCostUsd);
    savingsPct = period.baselineCostUsd === 0 ? undefined : savingsUsd / period.baselineCostUsd;
  }

  return {
    candidateRow: {
      rowType: 'candidate',
      periodKey: period.periodKey,
      provider,
      inputTokens: period.inputTokens,
      outputTokens: period.outputTokens,
      reasoningTokens: period.reasoningTokens,
      cacheReadTokens: period.cacheReadTokens,
      cacheWriteTokens: period.cacheWriteTokens,
      totalTokens: period.totalTokens,
      candidateModel,
      candidateResolvedModel,
      hypotheticalCostUsd,
      hypotheticalCostIncomplete,
      savingsUsd,
      savingsPct,
      notes: withNotes(notes),
    },
    missingPricing: notes.has('missing_pricing'),
    hasBaselineTokenMismatch,
  };
}

function compareCandidateRank(
  left: { candidateModel: string; hypotheticalCostUsd: number | undefined },
  right: { candidateModel: string; hypotheticalCostUsd: number | undefined },
): number {
  if (left.hypotheticalCostUsd === undefined && right.hypotheticalCostUsd !== undefined) {
    return 1;
  }

  if (left.hypotheticalCostUsd !== undefined && right.hypotheticalCostUsd === undefined) {
    return -1;
  }

  if (left.hypotheticalCostUsd !== undefined && right.hypotheticalCostUsd !== undefined) {
    if (left.hypotheticalCostUsd !== right.hypotheticalCostUsd) {
      return left.hypotheticalCostUsd - right.hypotheticalCostUsd;
    }
  }

  return compareByCodePoint(left.candidateModel, right.candidateModel);
}

function resolveBaselinePeriods(usageRows: UsageReportRow[]): BaselinePeriodTotals[] {
  const periodRows = new Map<string, UsageReportRow>();
  let grandTotalRow: UsageReportRow | undefined;

  for (const row of usageRows) {
    if (row.rowType === 'grand_total') {
      grandTotalRow = row;
      continue;
    }

    if (row.rowType === 'period_combined') {
      periodRows.set(row.periodKey, row);
      continue;
    }

    if (!periodRows.has(row.periodKey)) {
      periodRows.set(row.periodKey, row);
    }
  }

  const sortedPeriodKeys = [...periodRows.keys()].sort(compareByCodePoint);
  const periods = sortedPeriodKeys.map((periodKey) => {
    const row = periodRows.get(periodKey);

    if (!row) {
      throw new Error(`Missing baseline row for period ${periodKey}`);
    }

    return {
      periodKey,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      totalTokens: row.totalTokens,
      baselineCostUsd: row.costUsd,
      baselineCostIncomplete: row.costIncomplete === true,
    };
  });

  const allRow = grandTotalRow;

  if (allRow) {
    periods.push({
      periodKey: 'ALL',
      inputTokens: allRow.inputTokens,
      outputTokens: allRow.outputTokens,
      reasoningTokens: allRow.reasoningTokens,
      cacheReadTokens: allRow.cacheReadTokens,
      cacheWriteTokens: allRow.cacheWriteTokens,
      totalTokens: allRow.totalTokens,
      baselineCostUsd: allRow.costUsd,
      baselineCostIncomplete: allRow.costIncomplete === true,
    });
  } else {
    periods.push({
      periodKey: 'ALL',
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      baselineCostUsd: 0,
      baselineCostIncomplete: false,
    });
  }

  return periods;
}

function buildWarning(periodKeys: string[]): string | undefined {
  if (periodKeys.length === 0) {
    return undefined;
  }

  const sortedPeriodKeys = [...new Set(periodKeys)].sort(compareByCodePoint);

  return `Baseline cost exists for zero-token periods (${sortedPeriodKeys.join(', ')}); savings were omitted.`;
}

export function buildCounterfactualRows(
  input: BuildCounterfactualRowsInput,
): BuildCounterfactualRowsResult {
  const baselinePeriods = resolveBaselinePeriods(input.usageRows);
  const allPeriod = baselinePeriods.find((period) => period.periodKey === 'ALL');

  if (!allPeriod) {
    throw new Error('Missing ALL baseline totals');
  }

  const allPeriodEvaluations = input.candidateModels.map((candidateModel) =>
    evaluateCandidateForPeriod(allPeriod, input.provider, candidateModel, input.pricingSource),
  );

  const rankedCandidates = allPeriodEvaluations
    .map(({ candidateRow }) => ({
      candidateModel: candidateRow.candidateModel,
      hypotheticalCostUsd: candidateRow.hypotheticalCostUsd,
    }))
    .sort(compareCandidateRank)
    .map((candidate) => candidate.candidateModel);

  const selectedCandidates =
    input.top === undefined ? rankedCandidates : rankedCandidates.slice(0, input.top);

  const allEvaluationByCandidate = new Map(
    allPeriodEvaluations.map((evaluation) => [evaluation.candidateRow.candidateModel, evaluation]),
  );
  const candidatesWithMissingPricing = input.candidateModels
    .filter(
      (candidateModel) => allEvaluationByCandidate.get(candidateModel)?.missingPricing === true,
    )
    .sort(compareByCodePoint);

  const warningPeriods: string[] = [];
  const rows: OptimizeRow[] = [];

  for (const period of baselinePeriods) {
    rows.push(toBaselineRow(period, input.provider));

    for (const candidateModel of selectedCandidates) {
      const resolvedEvaluation =
        period.periodKey === 'ALL'
          ? allEvaluationByCandidate.get(candidateModel)
          : evaluateCandidateForPeriod(period, input.provider, candidateModel, input.pricingSource);

      if (!resolvedEvaluation) {
        continue;
      }

      if (resolvedEvaluation.hasBaselineTokenMismatch) {
        warningPeriods.push(period.periodKey);
      }

      rows.push(resolvedEvaluation.candidateRow);
    }
  }

  return {
    rows,
    candidatesWithMissingPricing,
    baselineCostIncomplete: allPeriod.baselineCostIncomplete,
    warning: buildWarning(warningPeriods),
  };
}
