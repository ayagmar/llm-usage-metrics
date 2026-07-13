import { describe, expect, it } from 'vitest';

import type { CompareDataResult, CompareMetricRow } from '../../src/cli/usage-data-contracts.js';
import { renderCompareShareSvg } from '../../src/render/render-compare-share-svg.js';

function createTotalsRow(overrides: Partial<CompareMetricRow> = {}): CompareMetricRow {
  return {
    key: 'costUsd',
    label: 'Cost',
    valueType: 'usd',
    current: 6.2,
    baseline: 10,
    delta: -3.8,
    deltaRatio: -0.38,
    ...overrides,
  };
}

function createCompareData(overrides: Partial<CompareDataResult> = {}): CompareDataResult {
  return {
    current: {
      window: { since: '2026-06-01', until: '2026-06-30', label: '2026-06' },
      totals: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        costUsd: 6.2,
        events: 3,
        activeDays: 2,
      },
    },
    baseline: {
      window: { since: '2026-05-01', until: '2026-05-31', label: '2026-05' },
      totals: {
        inputTokens: 200,
        outputTokens: 80,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 280,
        costUsd: 10,
        events: 5,
        activeDays: 4,
      },
    },
    totals: [
      createTotalsRow({
        key: 'totalTokens',
        label: 'Total',
        valueType: 'integer',
        current: 150,
        baseline: 280,
        delta: -130,
        deltaRatio: -0.46,
      }),
      createTotalsRow(),
      createTotalsRow({
        key: 'events',
        label: 'Events',
        valueType: 'integer',
        current: 3,
        baseline: 5,
        delta: -2,
        deltaRatio: -0.4,
      }),
      createTotalsRow({
        key: 'activeDays',
        label: 'Active days',
        valueType: 'integer',
        current: 2,
        baseline: 4,
        delta: -2,
        deltaRatio: -0.5,
      }),
    ],
    sources: [],
    diagnostics: {
      sessionStats: [],
      sourceFailures: [],
      skippedRows: [],
      pricingOrigin: 'none',
      activeEnvOverrides: [],
      timezone: 'UTC',
    },
    ...overrides,
  };
}

describe('renderCompareShareSvg', () => {
  it('renders a falling-cost headline in green with window labels', () => {
    const svg = renderCompareShareSvg(createCompareData());

    expect(svg).toContain('<svg');
    expect(svg).toContain('2026-06 vs 2026-05');
    expect(svg).toContain('llm-usage compare --share');
    expect(svg).toContain('▼ 38% vs baseline');
    expect(svg).toContain('#22c55e');
    expect(svg.match(/data-stat-tile="/g)).toHaveLength(4);
    expect(svg).toContain('was 280 (-46%)');
  });

  it('renders a rising-cost headline in red', () => {
    const data = createCompareData();
    data.totals[1] = createTotalsRow({ current: 12, baseline: 10, delta: 2, deltaRatio: 0.2 });

    const svg = renderCompareShareSvg(data);

    expect(svg).toContain('▲ 20% vs baseline');
    expect(svg).toContain('#ef4444');
  });

  it('omits the percent when the ratio is undefined and says no change at zero delta', () => {
    const risingNoRatio = createCompareData();
    risingNoRatio.totals[1] = createTotalsRow({
      current: 12,
      baseline: undefined,
      delta: 12,
      deltaRatio: undefined,
    });

    expect(renderCompareShareSvg(risingNoRatio)).toContain('▲ vs baseline');

    const unchanged = createCompareData();
    unchanged.totals[1] = createTotalsRow({ current: 10, baseline: 10, delta: 0, deltaRatio: 0 });

    expect(renderCompareShareSvg(unchanged)).toContain('no change vs baseline');
  });

  it('renders the no-data subtitle when both windows are empty', () => {
    const data = createCompareData();
    data.current.totals.events = 0;
    data.baseline.totals.events = 0;

    const svg = renderCompareShareSvg(data);

    expect(svg).toContain('No usage data in either window');
    expect(svg).not.toContain('2026-06 vs 2026-05');
  });

  it('escapes user-influenced strings', () => {
    const data = createCompareData();
    data.current.window.label = '<June>';

    const svg = renderCompareShareSvg(data);

    expect(svg).toContain('&lt;June&gt;');
    expect(svg).not.toContain('<June>');
  });
});
