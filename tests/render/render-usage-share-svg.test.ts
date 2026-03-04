import { describe, expect, it } from 'vitest';

import type { UsageDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderUsageShareSvg } from '../../src/render/render-usage-share-svg.js';

function createMultiSourceData(): UsageDataResult {
  return {
    events: [],
    rows: [
      {
        rowType: 'period_source',
        periodKey: '2026-01',
        source: 'pi',
        models: ['claude-4-sonnet'],
        modelBreakdown: [
          {
            model: 'claude-4-sonnet',
            inputTokens: 5000,
            outputTokens: 2000,
            reasoningTokens: 0,
            cacheReadTokens: 1000,
            cacheWriteTokens: 0,
            totalTokens: 8000,
            costUsd: 0.5,
          },
        ],
        inputTokens: 5000,
        outputTokens: 2000,
        reasoningTokens: 0,
        cacheReadTokens: 1000,
        cacheWriteTokens: 0,
        totalTokens: 8000,
        costUsd: 0.5,
      },
      {
        rowType: 'period_source',
        periodKey: '2026-01',
        source: 'codex',
        models: ['gpt-4.1'],
        modelBreakdown: [
          {
            model: 'gpt-4.1',
            inputTokens: 3000,
            outputTokens: 1000,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 4000,
            costUsd: 0.3,
          },
        ],
        inputTokens: 3000,
        outputTokens: 1000,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 4000,
        costUsd: 0.3,
      },
      {
        rowType: 'period_combined',
        periodKey: '2026-01',
        source: 'combined',
        models: ['claude-4-sonnet', 'gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 8000,
        outputTokens: 3000,
        reasoningTokens: 0,
        cacheReadTokens: 1000,
        cacheWriteTokens: 0,
        totalTokens: 12000,
        costUsd: 0.8,
      },
      {
        rowType: 'period_source',
        periodKey: '2026-02',
        source: 'pi',
        models: ['claude-4-sonnet'],
        modelBreakdown: [
          {
            model: 'claude-4-sonnet',
            inputTokens: 10000,
            outputTokens: 5000,
            reasoningTokens: 0,
            cacheReadTokens: 2000,
            cacheWriteTokens: 0,
            totalTokens: 17000,
            costUsd: 1.2,
          },
        ],
        inputTokens: 10000,
        outputTokens: 5000,
        reasoningTokens: 0,
        cacheReadTokens: 2000,
        cacheWriteTokens: 0,
        totalTokens: 17000,
        costUsd: 1.2,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['claude-4-sonnet', 'gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 18000,
        outputTokens: 8000,
        reasoningTokens: 0,
        cacheReadTokens: 3000,
        cacheWriteTokens: 0,
        totalTokens: 29000,
        costUsd: 2.0,
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

function createEmptyData(): UsageDataResult {
  return {
    events: [],
    rows: [
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: [],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
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

function createLargeTotalData(): UsageDataResult {
  return {
    events: [],
    rows: [
      {
        rowType: 'period_source',
        periodKey: '2026-02',
        source: 'codex',
        models: ['gpt-4.1'],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 296_700_000,
        costUsd: 109.98,
      },
      {
        rowType: 'period_source',
        periodKey: '2026-02',
        source: 'pi',
        models: ['claude-4-sonnet'],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 58_700,
        costUsd: 0,
      },
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['gpt-4.1', 'claude-4-sonnet'],
        modelBreakdown: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 296_800_000,
        costUsd: 109.98,
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

describe('renderUsageShareSvg', () => {
  it('renders a stacked area SVG with source legend and period labels', () => {
    const svg = renderUsageShareSvg(createMultiSourceData(), 'monthly');

    expect(svg).toContain('<svg');
    expect(svg).toContain('TOKENS');
    expect(svg).toContain('pi');
    expect(svg).toContain('codex');
    expect(svg).toContain('2026-01');
    expect(svg).toContain('2026-02');
    expect(svg).toContain('$2.00');
    expect(svg).toContain('llm-usage monthly --share');
  });

  it('renders dark theme background', () => {
    const svg = renderUsageShareSvg(createMultiSourceData(), 'monthly');

    expect(svg).toContain('#0d1117');
  });

  it('uses stacked area paths for multiple periods', () => {
    const svg = renderUsageShareSvg(createMultiSourceData(), 'monthly');

    expect(svg).toContain('clip-path="url(#chart-clip)"');
  });

  it('renders no-data message for empty data', () => {
    const svg = renderUsageShareSvg(createEmptyData(), 'daily');

    expect(svg).toContain('No usage data available');
    expect(svg).toContain('llm-usage daily --share');
  });

  it('adapts command badge text to granularity', () => {
    expect(renderUsageShareSvg(createEmptyData(), 'daily')).toContain('llm-usage daily --share');
    expect(renderUsageShareSvg(createEmptyData(), 'weekly')).toContain('llm-usage weekly --share');
    expect(renderUsageShareSvg(createEmptyData(), 'monthly')).toContain(
      'llm-usage monthly --share',
    );
  });

  it('renders single-period data as bars', () => {
    const data = createMultiSourceData();
    // Remove second period and combined rows, keep only 2026-01 source rows + grand total
    data.rows = data.rows.filter(
      (r) =>
        (r.rowType === 'period_source' && r.periodKey === '2026-01') || r.rowType === 'grand_total',
    );

    const svg = renderUsageShareSvg(data, 'monthly');

    expect(svg).toContain('<rect');
    expect(svg).not.toContain('clip-path="url(#chart-clip)"');
  });

  it('offsets source pills to avoid overlapping wide stat totals', () => {
    const svg = renderUsageShareSvg(createLargeTotalData(), 'monthly');
    const firstPillRectMatch =
      /<rect x="([0-9.]+)" y="34" width="[0-9.]+" height="30" rx="15" fill="[^"]+" fill-opacity="0.15"/.exec(
        svg,
      );
    expect(firstPillRectMatch).toBeTruthy();

    const firstPillX = Number(firstPillRectMatch?.[1]);
    expect(firstPillX).toBeGreaterThan(270);
  });
});
