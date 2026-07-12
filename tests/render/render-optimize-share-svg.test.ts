import { describe, expect, it } from 'vitest';

import type { OptimizeDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderOptimizeMonthlyShareSvg } from '../../src/render/render-optimize-share-svg.js';

function createData(): OptimizeDataResult {
  return {
    rows: [
      {
        rowType: 'baseline',
        periodKey: 'ALL',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        baselineCostUsd: 10,
        baselineCostIncomplete: false,
      },
      {
        rowType: 'candidate',
        periodKey: '2026-01',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        candidateModel: 'gpt-4.1',
        candidateResolvedModel: 'gpt-4.1',
        hypotheticalCostUsd: 8,
        hypotheticalCostIncomplete: false,
        savingsUsd: 2,
        savingsPct: 0.2,
      },
      {
        rowType: 'candidate',
        periodKey: '2026-02',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        candidateModel: 'gpt-4.1',
        candidateResolvedModel: 'gpt-4.1',
        hypotheticalCostUsd: 11,
        hypotheticalCostIncomplete: false,
        savingsUsd: -1,
        savingsPct: -0.1,
      },
      {
        rowType: 'candidate',
        periodKey: 'ALL',
        provider: 'openai',
        inputTokens: 200,
        outputTokens: 100,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 300,
        candidateModel: 'gpt-4.1',
        candidateResolvedModel: 'gpt-4.1',
        hypotheticalCostUsd: 19,
        hypotheticalCostIncomplete: false,
        savingsUsd: 1,
        savingsPct: 0.05,
      },
    ],
    diagnostics: {
      sessionStats: [],
      sourceFailures: [],
      skippedRows: [],
      pricingOrigin: 'none',
      activeEnvOverrides: [],
      timezone: 'UTC',
      provider: 'openai',
      baselineCostIncomplete: false,
      candidatesWithMissingPricing: [],
    },
  };
}

describe('renderOptimizeMonthlyShareSvg', () => {
  it('renders a monthly optimize SVG heatmap with candidate/month labels', () => {
    const svg = renderOptimizeMonthlyShareSvg(createData());

    expect(svg).toContain('<svg');
    expect(svg).toContain('Monthly Optimize');
    expect(svg).toContain('Provider:');
    expect(svg).toContain('openai');
    expect(svg).toContain('gpt-4.1');
    expect(svg).toContain('2026-01');
    expect(svg).toContain('2026-02');
    expect(svg).toContain('20.0%');
    expect(svg).toContain('-10.0%');
  });

  it('renders no-data, missing-pricing, and warning states', () => {
    const data = createData();
    data.rows = data.rows.filter((row) => row.rowType === 'baseline');
    data.diagnostics.candidatesWithMissingPricing = ['gpt-4o'];
    data.diagnostics.warning = 'Pricing unavailable for one candidate';

    const svg = renderOptimizeMonthlyShareSvg(data);

    expect(svg).toContain('No monthly optimize data available');
    expect(svg).toContain('Missing pricing: gpt-4o');
    expect(svg).toContain('Pricing unavailable for one candidate');
  });

  it('renders neutral and unknown candidate savings states', () => {
    const data = createData();
    data.rows.push(
      {
        rowType: 'candidate',
        periodKey: 'ALL',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        candidateModel: 'gpt-4o',
        candidateResolvedModel: 'gpt-4o',
        hypotheticalCostUsd: 10,
        hypotheticalCostIncomplete: false,
        savingsUsd: 0,
        savingsPct: 0,
      },
      {
        rowType: 'candidate',
        periodKey: '2026-03',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        candidateModel: 'gpt-4o',
        candidateResolvedModel: 'gpt-4o',
        hypotheticalCostUsd: 10,
        hypotheticalCostIncomplete: false,
        savingsUsd: 0,
        savingsPct: 0,
      },
      {
        rowType: 'candidate',
        periodKey: '2026-03',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        candidateModel: 'o3',
        candidateResolvedModel: 'o3',
        hypotheticalCostUsd: undefined,
        hypotheticalCostIncomplete: true,
        savingsUsd: undefined,
        savingsPct: undefined,
      },
    );

    const svg = renderOptimizeMonthlyShareSvg(data);

    expect(svg).toContain('0.0%');
    expect(svg).toContain('ALL: $0.00');
    expect(svg).toContain('>-</text>');
    expect(svg).toContain('rgba(139,148,158,0.15)');
  });
});
