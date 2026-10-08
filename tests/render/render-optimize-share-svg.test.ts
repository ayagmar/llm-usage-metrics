import { describe, expect, it } from 'vitest';

import type { OptimizeDataResult } from '../../src/cli/usage-data-contracts.js';
import type { OptimizeCandidateRow } from '../../src/optimize/optimize-row.js';
import { renderOptimizeMonthlyShareSvg } from '../../src/render/render-optimize-share-svg.js';
import { shareThemes } from '../../src/render/share-svg-theme.js';
import { HOSTILE_TEXT, renderInBothThemes } from './share-svg-assertions.js';

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
        savingsRatio: 0.2,
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
        savingsRatio: -0.1,
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
        savingsRatio: 0.05,
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

const dark = shareThemes.dark;

function candidate(
  candidateModel: string,
  periodKey: string,
  savingsRatio: number | undefined,
): OptimizeCandidateRow {
  return {
    rowType: 'candidate',
    periodKey,
    provider: 'openai',
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 150,
    candidateModel,
    candidateResolvedModel: candidateModel,
    hypotheticalCostUsd: savingsRatio === undefined ? undefined : 10 * (1 - savingsRatio),
    hypotheticalCostIncomplete: savingsRatio === undefined,
    savingsUsd: savingsRatio === undefined ? undefined : 10 * savingsRatio,
    savingsRatio,
  };
}

/** Candidate names down the left of the grid, which starts below y=300. */
function rowLabels(svg: string): string[] {
  return [...svg.matchAll(/<text x="64" y="([0-9.]+)" font-size="16"[^>]*>([^<]+)</gu)]
    .filter((match) => Number(match[1]) > 300)
    .map((match) => match[2]);
}

describe('renderOptimizeMonthlyShareSvg', () => {
  it('renders the actual cost, the best candidate, and a savings grid in both themes', () => {
    const [svg] = renderInBothThemes((theme) => renderOptimizeMonthlyShareSvg(createData(), theme));

    expect(svg).toContain('>Optimize<');
    expect(svg).toContain('openai usage priced on other models; positive means cheaper');
    expect(svg).toContain('$10.00');
    expect(svg).toContain('It would save');
    expect(svg).toContain('>$1.00<');
    expect(svg).toContain('5.0% cheaper');
    expect(svg).toContain('>+20.0%<');
    expect(svg).toContain('>-10.0%<');
    expect(svg).toContain('$ llm-usage optimize monthly --share');
    expect(svg).toContain('2026-01 to 2026-02');
  });

  it('sorts candidates by savings and colors cells by sign', () => {
    const data = createData();
    data.rows.push(
      candidate('cheaper', 'ALL', 0.5),
      candidate('cheaper', '2026-01', 0.5),
      candidate('pricier', 'ALL', -0.3),
      candidate('pricier', '2026-01', -0.3),
    );

    const svg = renderOptimizeMonthlyShareSvg(data, dark);

    expect(rowLabels(svg)).toEqual(['cheaper', 'gpt-4.1', 'pricier']);
    expect(svg).toMatch(
      new RegExp(`fill="${dark.positive}" fill-opacity="0.55"/>\\n<text[^>]*>\\+50\\.0%<`, 'u'),
    );
    expect(svg).toMatch(
      new RegExp(`fill="${dark.negative}" fill-opacity="0.43"/>\\n<text[^>]*>-30\\.0%<`, 'u'),
    );
  });

  it('keeps candidates without a whole-window row, last, and shows unpriced cells as a dash', () => {
    const data = createData();
    data.rows.push(candidate('o3', '2026-01', undefined));

    const svg = renderOptimizeMonthlyShareSvg(data, dark);

    expect(rowLabels(svg)).toEqual(['gpt-4.1', 'o3']);
    expect(svg).toMatch(/fill-opacity="0.60"\/>\n<text[^>]*>-</u);
  });

  it('caps the grid at five candidates and eight months', () => {
    const data = createData();
    for (let index = 0; index < 7; index += 1) {
      data.rows.push(candidate(`m${index}`, 'ALL', index / 10));
      for (let month = 1; month <= 10; month += 1) {
        data.rows.push(candidate(`m${index}`, `2025-${String(month).padStart(2, '0')}`, 0.1));
      }
    }

    const svg = renderOptimizeMonthlyShareSvg(data, dark);

    expect(rowLabels(svg)).toEqual(['m6', 'm5', 'm4', 'm3', 'm2']);
    expect(svg).not.toContain('>2025-03<');
    expect(svg).toContain('>2025-05<');
    expect(svg).toContain('>2026-02<');
  });

  it('keeps pricing notes on an empty card', () => {
    const data = createData();
    data.rows = data.rows.filter((row) => row.rowType === 'baseline');
    data.diagnostics.candidatesWithMissingPricing = ['gpt-4o'];
    data.diagnostics.warning = 'Pricing unavailable for one candidate';

    const [svg] = renderInBothThemes((theme) => renderOptimizeMonthlyShareSvg(data, theme));

    expect(svg).toContain('No months to compare');
    expect(svg).toContain('Missing pricing: gpt-4o; Pricing unavailable for one candidate');
  });

  it('describes a best candidate that still costs more', () => {
    const data = createData();
    data.rows = data.rows.filter((row) => row.rowType === 'baseline');
    data.rows.push(candidate('pricier', 'ALL', -0.25), candidate('pricier', '2026-01', -0.25));

    const svg = renderOptimizeMonthlyShareSvg(data, dark);

    expect(svg).toContain('It would cost more by');
    expect(svg).toContain('25.0% more expensive');
  });

  it('escapes candidate names', () => {
    const data = createData();
    data.rows.push(candidate(HOSTILE_TEXT, 'ALL', 0.9), candidate(HOSTILE_TEXT, '2026-01', 0.9));

    const [svg] = renderInBothThemes((theme) => renderOptimizeMonthlyShareSvg(data, theme));

    expect(svg).not.toContain('<script');
  });
});
