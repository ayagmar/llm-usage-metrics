import { describe, expect, it } from 'vitest';

import type { UsageDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderUsageShareSvg } from '../../src/render/render-usage-share-svg.js';
import { getSourceColor, shareThemes } from '../../src/render/share-svg-theme.js';
import { HOSTILE_TEXT, renderInBothThemes } from './share-svg-assertions.js';

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

function createManySourcesData(sourceNames: string[]): UsageDataResult {
  const sourceRows = sourceNames.map((source, i) => ({
    rowType: 'period_source' as const,
    periodKey: '2026-01',
    source,
    models: ['m'],
    modelBreakdown: [],
    inputTokens: 10_000 + i * 1_000,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 10_000 + i * 1_000,
    costUsd: 1,
  }));
  const grandTotalTokens = sourceRows.reduce((sum, r) => sum + r.totalTokens, 0);

  return {
    events: [],
    rows: [
      ...sourceRows,
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        source: 'combined',
        models: ['m'],
        modelBreakdown: [],
        inputTokens: grandTotalTokens,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: grandTotalTokens,
        costUsd: sourceNames.length,
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

const dark = shareThemes.dark;
const legendPattern = /data-legend="([^"]+)">\n<rect [^>]*fill="([^"]+)"/gu;

function legendEntries(svg: string): [string, string][] {
  return [...svg.matchAll(legendPattern)].map((match) => [match[1], match[2]]);
}

function withPeriods(data: UsageDataResult, periodKeys: string[]): UsageDataResult {
  const [template] = data.rows.filter((row) => row.rowType === 'period_source');

  return {
    ...data,
    rows: [
      ...periodKeys.map((periodKey) => ({ ...template, periodKey })),
      ...data.rows.filter((row) => row.rowType === 'grand_total'),
    ],
  };
}

describe('renderUsageShareSvg', () => {
  it('renders cost, tokens, a source legend, and stacked bars in both themes', () => {
    const [svg] = renderInBothThemes((theme) =>
      renderUsageShareSvg(createMultiSourceData(), 'monthly', theme),
    );

    expect(svg).toContain('Monthly usage');
    expect(svg).toContain('$2.00');
    expect(svg).toContain('29k');
    expect(svg).toContain('2 months with usage');
    expect(svg).toContain('$ llm-usage monthly --share');
    expect(svg).toContain('2026-01 to 2026-02');
    expect(svg).toContain('>Jan 2026<');
    expect(svg).toContain('>Feb 2026<');
    // Largest source first, with its share of all tokens.
    expect(legendEntries(svg).map(([source]) => source)).toEqual(['pi', 'codex']);
    expect(svg).toContain('>86%<');
    expect(svg).toContain('>14%<');
    // January stacks pi and codex; February is pi alone.
    expect(
      svg.match(/<rect x="[0-9.]+" y="[0-9.]+" width="[0-9.]+" height="[0-9.]+" fill="/gu),
    ).toHaveLength(3);
  });

  it('labels periods for each granularity', () => {
    const daily = renderUsageShareSvg(
      withPeriods(createManySourcesData(['pi']), ['2026-01-02', '2026-01-03']),
      'daily',
      dark,
    );
    const weekly = renderUsageShareSvg(
      withPeriods(createManySourcesData(['pi']), ['2026-W01', '2026-W02']),
      'weekly',
      dark,
    );

    expect(daily).toContain('Daily usage');
    expect(daily).toContain('>Jan 2<');
    expect(daily).toContain('2 days with usage');
    expect(weekly).toContain('Weekly usage');
    expect(weekly).toContain('>W02<');
    expect(weekly).toContain('$ llm-usage weekly --share');
  });

  it('keeps an empty slot for each period without usage', () => {
    const [svg] = renderInBothThemes((theme) =>
      renderUsageShareSvg(
        withPeriods(createManySourcesData(['pi']), ['2026-03', '2026-06']),
        'monthly',
        theme,
      ),
    );

    expect(svg.match(/>\w{3} 2026</gu)).toEqual([
      '>Mar 2026<',
      '>Apr 2026<',
      '>May 2026<',
      '>Jun 2026<',
    ]);
    expect(svg).toContain('2 months with usage');
    // Two bars across four slots: Mar in the first, Jun in the last.
    const barXs = [...svg.matchAll(/<rect x="([0-9.]+)" y="[0-9.]+" width="[0-9.]+" height/gu)]
      .map((match) => Number(match[1]))
      .filter((x) => x >= 420); // chart area; the legend swatches sit left of it
    expect(barXs).toHaveLength(2);
    expect(barXs[1] - barXs[0]).toBeCloseTo((3 * (1136 - 420)) / 4, 1);
  });

  it('drops characters XML forbids from source names', () => {
    renderInBothThemes((theme) =>
      renderUsageShareSvg(createManySourcesData(['bad\u0001name\uD800']), 'monthly', theme),
    );
  });

  it('draws at most eight period labels', () => {
    const periods = Array.from(
      { length: 30 },
      (_, index) => `2026-01-${String(index + 1).padStart(2, '0')}`,
    );
    const svg = renderUsageShareSvg(
      withPeriods(createManySourcesData(['pi']), periods),
      'daily',
      dark,
    );

    expect(svg.match(/>Jan \d+</gu)).toHaveLength(8);
  });

  it('keeps six legend rows and folds the smallest sources into one', () => {
    const names = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'pi'];
    const [svg] = renderInBothThemes((theme) =>
      renderUsageShareSvg(createManySourcesData(names), 'monthly', theme),
    );
    const entries = legendEntries(svg);

    // Tokens grow with the index, so pi is largest and a1..c3 fold into "3 more".
    expect(entries.map(([source]) => source)).toEqual(['pi', 'g7', 'f6', 'e5', 'd4', '3 more']);
    expect(entries.at(-1)?.[1]).toBe(dark.textMuted);
    // Named colors follow the alphabetical source order, as in every other report.
    expect(entries[0]?.[1]).toBe(getSourceColor('pi', 7));
    expect(entries[1]?.[1]).toBe(getSourceColor('g7', 6));
    expect(new Set(entries.map(([, color]) => color)).size).toBe(6);
  });

  it('shows <1% for a source with a tiny share', () => {
    const data = createManySourcesData(['big', 'tiny']);
    const [bigRow, tinyRow] = data.rows;
    bigRow.totalTokens = 1_000_000;
    tinyRow.totalTokens = 10;

    expect(renderUsageShareSvg(data, 'monthly', dark)).toContain('>&lt;1%<');
  });

  it('escapes and shortens hostile source names', () => {
    const [svg] = renderInBothThemes((theme) =>
      renderUsageShareSvg(createManySourcesData([HOSTILE_TEXT]), 'monthly', theme),
    );

    expect(svg).not.toContain('<script');
    expect(svg).toContain('&lt;script&gt;alert(&quot;x&quot;…');
  });

  it('shows an empty state without usage', () => {
    const [svg] = renderInBothThemes((theme) =>
      renderUsageShareSvg(createEmptyData(), 'monthly', theme),
    );

    expect(svg).toContain('No usage in this window');
    expect(legendEntries(svg)).toEqual([]);
  });
});
