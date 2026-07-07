import { describe, expect, it } from 'vitest';

import { renderCompareReport } from '../../src/render/render-compare-report.js';
import type { CompareDataResult } from '../../src/cli/usage-data-contracts.js';

function createCompareData(): CompareDataResult {
  return {
    current: {
      window: { since: '2026-06-01', until: '2026-06-30', label: '2026-06' },
      totals: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        totalTokens: 180,
        costUsd: 3,
        costIncomplete: true,
        events: 2,
        activeDays: 2,
      },
    },
    baseline: {
      window: { since: '2026-05-01', until: '2026-05-31', label: '2026-05' },
      totals: {
        inputTokens: 80,
        outputTokens: 40,
        reasoningTokens: 0,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        totalTokens: 130,
        costUsd: 2,
        events: 1,
        activeDays: 1,
      },
    },
    totals: [
      {
        key: 'inputTokens',
        label: 'Input',
        valueType: 'integer',
        current: 100,
        baseline: 80,
        delta: 20,
        deltaPercent: 0.25,
      },
      {
        key: 'costUsd',
        label: 'Cost',
        valueType: 'usd',
        current: 3,
        baseline: 2,
        delta: 1,
        deltaPercent: 0.5,
        currentCostIncomplete: true,
        deltaCostIncomplete: true,
      },
      {
        key: 'reasoningTokens',
        label: 'Reasoning',
        valueType: 'integer',
        current: 0,
        baseline: 0,
        delta: 0,
        deltaPercent: 0,
      },
    ],
    sources: [
      {
        source: 'co|dex',
        current: {
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          totalTokens: 180,
          costUsd: 3,
          costIncomplete: true,
          events: 2,
          activeDays: 2,
        },
        baseline: {
          inputTokens: 80,
          outputTokens: 40,
          reasoningTokens: 0,
          cacheReadTokens: 10,
          cacheWriteTokens: 0,
          totalTokens: 130,
          costUsd: 2,
          events: 1,
          activeDays: 1,
        },
        delta: {
          inputTokens: 20,
          outputTokens: 10,
          reasoningTokens: 0,
          cacheReadTokens: 10,
          cacheWriteTokens: 10,
          totalTokens: 50,
          costUsd: 1,
          costIncomplete: true,
          events: 1,
          activeDays: 1,
        },
        deltaPercent: {
          costUsd: 0.5,
        },
      },
    ],
    diagnostics: {
      sessionStats: [],
      sourceFailures: [],
      skippedRows: [],
      pricingOrigin: 'none',
      activeEnvOverrides: [],
      timezone: 'UTC',
    },
  };
}

describe('renderCompareReport', () => {
  it('renders terminal output without color', () => {
    const output = renderCompareReport(createCompareData(), 'terminal', { useColor: false });

    expect(output).toContain('Compare: 2026-06 vs 2026-05');
    expect(output).toContain('Metric');
    expect(output).toContain('Input');
    expect(output).toContain('+20');
    expect(output).toContain('~$3.00');
    expect(output).toContain('~+$1.00');
    expect(output).toContain('By source (cost)');
    expect(output).toContain('co|dex');
  });

  it('renders markdown output with escaped table cells', () => {
    const output = renderCompareReport(createCompareData(), 'markdown');

    expect(output).toContain('### Compare: 2026-06 vs 2026-05');
    expect(output).toContain('| Metric');
    expect(output).toContain('~+$1.00');
    expect(output).toContain('co\\|dex');
  });

  it('renders structured JSON output', () => {
    const output = renderCompareReport(createCompareData(), 'json');
    const parsed = JSON.parse(output) as CompareDataResult;

    expect(parsed.current.window).toEqual({
      since: '2026-06-01',
      until: '2026-06-30',
      label: '2026-06',
    });
    expect(parsed.totals[0]).toMatchObject({ key: 'inputTokens', delta: 20 });
    expect(parsed.sources[0]).toMatchObject({ source: 'co|dex' });
  });
});
