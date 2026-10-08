import { describe, expect, it } from 'vitest';

import type { CompareDataResult, CompareMetricRow } from '../../src/cli/usage-data-contracts.js';
import { renderCompareShareSvg } from '../../src/render/render-compare-share-svg.js';
import { shareThemes } from '../../src/render/share-svg-theme.js';
import { HOSTILE_TEXT, renderInBothThemes } from './share-svg-assertions.js';

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

const dark = shareThemes.dark;

function headlineDelta(svg: string): { text: string; fill: string } {
  const match = /<text [^>]*fill="([^"]+)"[^>]*data-headline-delta="true">([^<]*)</u.exec(svg);
  return { fill: match?.[1] ?? '', text: match?.[2] ?? '' };
}

function barWidths(svg: string, metric: string): number[] {
  const group = svg.slice(svg.indexOf(`data-compare-metric="${metric}"`));
  return [...group.slice(0, group.indexOf('</g>')).matchAll(/<rect [^>]*width="([0-9.]+)"/gu)].map(
    (match) => Number(match[1]),
  );
}

describe('renderCompareShareSvg', () => {
  it('leads with current cost and pairs current and baseline bars per metric', () => {
    const [svg] = renderInBothThemes((theme) => renderCompareShareSvg(createCompareData(), theme));

    expect(svg).toContain('2026-06 against 2026-05');
    expect(svg).toContain('$6.20');
    expect(svg).toContain('2026-05: $10.00');
    expect(svg).toContain('$ llm-usage compare --share');
    expect(svg).toContain('2026-06-01 to 2026-06-30');
    expect([...svg.matchAll(/data-compare-metric="([^"]+)"/gu)].map((match) => match[1])).toEqual([
      'costUsd',
      'totalTokens',
      'events',
      'activeDays',
    ]);
    // The larger value fills the bar; the smaller one is drawn to scale.
    expect(barWidths(svg, 'costUsd')).toEqual([235.6, 380]);
    expect(svg).toContain('>-46%<');
  });

  it('reads a cost drop as positive and a rise as negative', () => {
    expect(headlineDelta(renderCompareShareSvg(createCompareData(), dark))).toEqual({
      text: 'Down $3.80 (38%) from the baseline',
      fill: dark.positive,
    });

    const rising = createCompareData();
    rising.totals[1] = createTotalsRow({ current: 12, baseline: 10, delta: 2, deltaRatio: 0.2 });
    expect(headlineDelta(renderCompareShareSvg(rising, dark))).toEqual({
      text: 'Up $2.00 (20%) from the baseline',
      fill: dark.negative,
    });
  });

  it('omits the percent without a ratio and says no change at zero delta', () => {
    const noRatio = createCompareData();
    noRatio.totals[1] = createTotalsRow({
      current: 12,
      baseline: undefined,
      delta: 12,
      deltaRatio: undefined,
      deltaCostIncomplete: true,
    });
    expect(headlineDelta(renderCompareShareSvg(noRatio, dark)).text).toBe(
      'Up ~$12.00 from the baseline',
    );

    const unchanged = createCompareData();
    unchanged.totals[1] = createTotalsRow({ current: 10, baseline: 10, delta: 0, deltaRatio: 0 });
    expect(headlineDelta(renderCompareShareSvg(unchanged, dark))).toEqual({
      text: 'No change from the baseline',
      fill: dark.textSecondary,
    });
  });

  it('shows an empty state when both windows are empty', () => {
    const data = createCompareData();
    data.current.totals.events = 0;
    data.baseline.totals.events = 0;

    const [svg] = renderInBothThemes((theme) => renderCompareShareSvg(data, theme));

    expect(svg).toContain('No usage in either window');
    expect(svg).not.toContain('data-compare-metric=');
  });

  it('escapes window labels', () => {
    const data = createCompareData();
    data.current.window.label = HOSTILE_TEXT;

    const [svg] = renderInBothThemes((theme) => renderCompareShareSvg(data, theme));

    expect(svg).not.toContain('<script');
    expect(svg).toContain('&lt;script&gt;');
  });
});
