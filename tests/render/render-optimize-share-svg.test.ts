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
      usage: {
        sessionStats: [],
        sourceFailures: [],
        skippedRows: [],
        pricingOrigin: 'none',
        activeEnvOverrides: [],
        timezone: 'UTC',
      },
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
});
