import { describe, expect, it } from 'vitest';

import {
  buildCounterfactualRows,
  normalizeCandidateModels,
  parseTopOption,
} from '../../src/optimize/aggregate-counterfactual.js';
import {
  createDefaultOpenAiPricingSource,
  StaticPricingSource,
} from '../helpers/static-pricing-source.js';
import type { UsageReportRow } from '../../src/domain/usage-report-row.js';

function createUsageRows(
  overrides: { costUsd?: number; costIncomplete?: boolean } = {},
): UsageReportRow[] {
  const baselineCostUsd = 'costUsd' in overrides ? overrides.costUsd : 2.8;
  const baselineCostIncomplete = 'costIncomplete' in overrides ? overrides.costIncomplete : false;

  return [
    {
      rowType: 'period_source',
      periodKey: '2026-02-10',
      source: 'pi',
      models: ['gpt-4.1'],
      modelBreakdown: [],
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_100_000,
      costUsd: baselineCostUsd,
      costIncomplete: baselineCostIncomplete,
    },
    {
      rowType: 'grand_total',
      periodKey: 'ALL',
      source: 'combined',
      models: ['gpt-4.1'],
      modelBreakdown: [],
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_100_000,
      costUsd: baselineCostUsd,
      costIncomplete: baselineCostIncomplete,
    },
  ];
}

describe('aggregate-counterfactual', () => {
  it('normalizes candidate models from repeated/comma-separated values', () => {
    expect(normalizeCandidateModels([' GPT-4.1 , gpt-5-codex ', 'gpt-4.1'])).toEqual([
      'gpt-4.1',
      'gpt-5-codex',
    ]);
  });

  it('rejects missing or empty candidate models', () => {
    expect(() => normalizeCandidateModels(undefined)).toThrow(
      'At least one --candidate-model is required',
    );
    expect(() => normalizeCandidateModels([' , ', '   '])).toThrow(
      '--candidate-model must contain at least one non-empty model name',
    );
  });

  it('parses --top and rejects invalid values', () => {
    expect(parseTopOption(undefined)).toBeUndefined();
    expect(parseTopOption('2')).toBe(2);
    expect(() => parseTopOption('0')).toThrow('--top must be a positive integer');
    expect(() => parseTopOption('abc')).toThrow('--top must be a positive integer');
  });

  it('matches cost-engine semantics for counterfactual costs', () => {
    const result = buildCounterfactualRows({
      usageRows: createUsageRows(),
      provider: 'openai',
      candidateModels: ['gpt-4.1', 'gpt-5-codex'],
      pricingSource: createDefaultOpenAiPricingSource(),
    });

    const allCandidateRows = result.rows.filter(
      (row) => row.rowType === 'candidate' && row.periodKey === 'ALL',
    );

    expect(allCandidateRows[0]).toMatchObject({
      candidateModel: 'gpt-5-codex',
      hypotheticalCostUsd: 2.5,
      savingsUsd: 0.3,
    });
    expect(allCandidateRows[1]).toMatchObject({
      candidateModel: 'gpt-4.1',
      hypotheticalCostUsd: 2.8,
      savingsUsd: 0,
      savingsPct: 0,
    });
  });

  it('prefers period_combined rows over source rows when both are present', () => {
    const usageRows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        costUsd: 2,
      },
      {
        rowType: 'period_combined',
        periodKey: '2026-02-10',
        source: 'combined',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 200,
        outputTokens: 60,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 260,
        costUsd: 3,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 200,
        outputTokens: 60,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 260,
        costUsd: 3,
      },
    ];

    const result = buildCounterfactualRows({
      usageRows,
      provider: 'openai',
      candidateModels: ['gpt-4.1'],
      pricingSource: createDefaultOpenAiPricingSource(),
    });

    expect(
      result.rows.find((row) => row.rowType === 'baseline' && row.periodKey === '2026-02-10'),
    ).toMatchObject({
      totalTokens: 260,
      baselineCostUsd: 3,
    });
  });

  it('sums source-only baseline rows when no period_combined row exists', () => {
    const usageRows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1_100_000,
        costUsd: 2.8,
      },
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'codex',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 500_000,
        outputTokens: 50_000,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 550_000,
        costUsd: 1.4,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 1_500_000,
        outputTokens: 150_000,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1_650_000,
        costUsd: 4.2,
      },
    ];

    const result = buildCounterfactualRows({
      usageRows,
      provider: 'openai',
      candidateModels: ['gpt-5-codex'],
      pricingSource: createDefaultOpenAiPricingSource(),
    });

    const baselineRow = result.rows.find(
      (row) => row.rowType === 'baseline' && row.periodKey === '2026-02-10',
    );
    const candidateRow = result.rows.find(
      (row) => row.rowType === 'candidate' && row.periodKey === '2026-02-10',
    );

    expect(baselineRow).toMatchObject({
      totalTokens: 1_650_000,
      baselineCostUsd: 4.2,
    });
    expect(candidateRow).toMatchObject({
      hypotheticalCostUsd: 3.75,
      savingsUsd: 0.45,
    });
  });

  it('preserves prior source costs when merged rows omit later cost fields', () => {
    const usageRows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1_100_000,
        costUsd: 2.8,
      },
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'codex',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 500_000,
        outputTokens: 50_000,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 550_000,
        costIncomplete: true,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 1_500_000,
        outputTokens: 150_000,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1_650_000,
        costUsd: 4.2,
        costIncomplete: true,
      },
    ];

    const result = buildCounterfactualRows({
      usageRows,
      provider: 'openai',
      candidateModels: ['gpt-5-codex'],
      pricingSource: createDefaultOpenAiPricingSource(),
    });

    expect(
      result.rows.find((row) => row.rowType === 'baseline' && row.periodKey === '2026-02-10'),
    ).toMatchObject({
      baselineCostUsd: 2.8,
      baselineCostIncomplete: true,
      totalTokens: 1_650_000,
    });
  });

  it('creates a zeroed ALL baseline row when usage rows are empty', () => {
    const result = buildCounterfactualRows({
      usageRows: [],
      provider: 'openai',
      candidateModels: ['gpt-4.1'],
      pricingSource: createDefaultOpenAiPricingSource(),
    });

    expect(result.rows[0]).toMatchObject({
      rowType: 'baseline',
      periodKey: 'ALL',
      baselineCostUsd: 0,
      baselineCostIncomplete: false,
      totalTokens: 0,
    });
  });

  it('sorts tied hypothetical costs by candidate model name', () => {
    const pricing = new StaticPricingSource({
      pricingByModel: {
        alpha: { inputPer1MUsd: 2, outputPer1MUsd: 8 },
        beta: { inputPer1MUsd: 2, outputPer1MUsd: 8 },
      },
    });

    const result = buildCounterfactualRows({
      usageRows: createUsageRows(),
      provider: 'openai',
      candidateModels: ['beta', 'alpha'],
      pricingSource: pricing,
    });

    const allCandidates = result.rows.filter(
      (row): row is Extract<(typeof result.rows)[number], { rowType: 'candidate' }> =>
        row.rowType === 'candidate' && row.periodKey === 'ALL',
    );

    expect(allCandidates.map((row) => row.candidateModel)).toEqual(['alpha', 'beta']);
  });

  it('sorts missing pricing candidates last and reports missing coverage', () => {
    const pricing = new StaticPricingSource({
      pricingByModel: {
        'gpt-4.1': {
          inputPer1MUsd: 2,
          outputPer1MUsd: 8,
        },
      },
    });

    const result = buildCounterfactualRows({
      usageRows: createUsageRows(),
      provider: 'openai',
      candidateModels: ['missing-model', 'gpt-4.1'],
      pricingSource: pricing,
    });

    const allCandidates = result.rows.filter(
      (row): row is Extract<(typeof result.rows)[number], { rowType: 'candidate' }> =>
        row.rowType === 'candidate' && row.periodKey === 'ALL',
    );

    expect(allCandidates.map((row) => row.candidateModel)).toEqual(['gpt-4.1', 'missing-model']);
    expect(allCandidates[1]).toMatchObject({
      hypotheticalCostUsd: undefined,
      hypotheticalCostIncomplete: true,
      notes: ['missing_pricing'],
    });
    expect(result.candidatesWithMissingPricing).toEqual(['missing-model']);
  });

  it('suppresses savings when baseline is incomplete', () => {
    const result = buildCounterfactualRows({
      usageRows: createUsageRows({ costUsd: undefined, costIncomplete: true }),
      provider: 'openai',
      candidateModels: ['gpt-4.1'],
      pricingSource: createDefaultOpenAiPricingSource(),
    });

    const candidateRow = result.rows.find(
      (row) => row.rowType === 'candidate' && row.periodKey === 'ALL',
    );

    expect(candidateRow).toMatchObject({
      savingsUsd: undefined,
      savingsPct: undefined,
      notes: ['baseline_incomplete'],
    });
  });

  it('treats total-only periods as usage-bucket incomplete instead of hypothetical $0', () => {
    const usageRows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['gpt-5.2'],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 40,
        costUsd: undefined,
        costIncomplete: true,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['gpt-5.2'],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 40,
        costUsd: undefined,
        costIncomplete: true,
      },
    ];

    const result = buildCounterfactualRows({
      usageRows,
      provider: 'openai',
      candidateModels: ['gpt-5.2'],
      pricingSource: createDefaultOpenAiPricingSource(),
    });

    const candidateRow = result.rows.find(
      (row) => row.rowType === 'candidate' && row.periodKey === 'ALL',
    );

    expect(candidateRow).toMatchObject({
      hypotheticalCostUsd: undefined,
      hypotheticalCostIncomplete: true,
      notes: ['baseline_incomplete', 'usage_buckets_missing'],
    });
  });

  it('treats reasoning-only periods as usage-bucket incomplete when reasoning is included in output pricing', () => {
    const pricing = new StaticPricingSource({
      pricingByModel: {
        'gpt-5.2': {
          inputPer1MUsd: 1,
          outputPer1MUsd: 2,
        },
      },
    });

    const usageRows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['gpt-5.2'],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 40,
        costUsd: undefined,
        costIncomplete: true,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['gpt-5.2'],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 40,
        costUsd: undefined,
        costIncomplete: true,
      },
    ];

    const result = buildCounterfactualRows({
      usageRows,
      provider: 'openai',
      candidateModels: ['gpt-5.2'],
      pricingSource: pricing,
    });

    const candidateRow = result.rows.find(
      (row) => row.rowType === 'candidate' && row.periodKey === 'ALL',
    );

    expect(candidateRow).toMatchObject({
      hypotheticalCostUsd: undefined,
      hypotheticalCostIncomplete: true,
      notes: ['baseline_incomplete', 'usage_buckets_missing'],
    });
  });

  it('treats cache-read-only periods as missing pricing when cache read pricing is missing', () => {
    const pricing = new StaticPricingSource({
      pricingByModel: {
        'gpt-5.2': {
          inputPer1MUsd: 1,
          outputPer1MUsd: 2,
        },
      },
    });

    const usageRows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: ['gpt-5.2'],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        totalTokens: 40,
        costUsd: undefined,
        costIncomplete: true,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['gpt-5.2'],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        totalTokens: 40,
        costUsd: undefined,
        costIncomplete: true,
      },
    ];

    const result = buildCounterfactualRows({
      usageRows,
      provider: 'openai',
      candidateModels: ['gpt-5.2'],
      pricingSource: pricing,
    });

    const candidateRow = result.rows.find(
      (row) => row.rowType === 'candidate' && row.periodKey === 'ALL',
    );

    expect(candidateRow).toMatchObject({
      hypotheticalCostUsd: undefined,
      hypotheticalCostIncomplete: true,
      notes: ['baseline_incomplete', 'missing_pricing'],
    });
  });

  it('keeps hypothetical cost at zero when a period has no billable buckets and no usage signal', () => {
    const usageRows: UsageReportRow[] = [
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['gpt-5.2'],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        costIncomplete: false,
      },
    ];

    const result = buildCounterfactualRows({
      usageRows,
      provider: 'openai',
      candidateModels: ['gpt-5.2'],
      pricingSource: createDefaultOpenAiPricingSource(),
    });

    expect(result.rows.find((row) => row.rowType === 'candidate')).toMatchObject({
      hypotheticalCostUsd: 0,
      hypotheticalCostIncomplete: false,
    });
  });

  it('applies --top using ALL-period ranking consistently across periods', () => {
    const usageRows: UsageReportRow[] = [
      {
        rowType: 'period_source',
        periodKey: '2026-02-09',
        source: 'pi',
        models: [],
        modelBreakdown: [],
        inputTokens: 500_000,
        outputTokens: 50_000,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 550_000,
        costUsd: 1.4,
      },
      {
        rowType: 'period_source',
        periodKey: '2026-02-10',
        source: 'pi',
        models: [],
        modelBreakdown: [],
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1_100_000,
        costUsd: 2.8,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: [],
        modelBreakdown: [],
        inputTokens: 1_500_000,
        outputTokens: 150_000,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1_650_000,
        costUsd: 4.2,
      },
    ];

    const result = buildCounterfactualRows({
      usageRows,
      provider: 'openai',
      candidateModels: ['gpt-4.1', 'gpt-5-codex'],
      pricingSource: createDefaultOpenAiPricingSource(),
      top: 1,
    });

    const candidateRows = result.rows.filter((row) => row.rowType === 'candidate');

    expect(candidateRows).toHaveLength(3);
    expect(new Set(candidateRows.map((row) => row.candidateModel))).toEqual(
      new Set(['gpt-5-codex']),
    );
  });

  it('reports missing pricing diagnostics for all requested candidates, not only top-N', () => {
    const pricing = new StaticPricingSource({
      pricingByModel: {
        'gpt-4.1': {
          inputPer1MUsd: 2,
          outputPer1MUsd: 8,
        },
      },
    });

    const result = buildCounterfactualRows({
      usageRows: createUsageRows(),
      provider: 'openai',
      candidateModels: ['gpt-4.1', 'missing-model-a', 'missing-model-b'],
      pricingSource: pricing,
      top: 1,
    });

    const allRowsCandidates = result.rows
      .filter(
        (row): row is Extract<(typeof result.rows)[number], { rowType: 'candidate' }> =>
          row.rowType === 'candidate' && row.periodKey === 'ALL',
      )
      .map((row) => row.candidateModel);

    expect(allRowsCandidates).toEqual(['gpt-4.1']);
    expect(result.candidatesWithMissingPricing).toEqual(['missing-model-a', 'missing-model-b']);
  });
});
