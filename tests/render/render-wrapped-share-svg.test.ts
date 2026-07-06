import { describe, expect, it } from 'vitest';

import { renderWrappedShareSvg } from '../../src/render/render-wrapped-share-svg.js';
import type { WrappedRecap } from '../../src/wrapped/wrapped-recap.js';

function createRecap(): WrappedRecap {
  return {
    year: 2026,
    timezone: 'UTC',
    from: '2026-01-01',
    to: '2026-12-31',
    totalTokens: 1_234_500,
    totalCostUsd: 123.45,
    costIncomplete: true,
    activeDays: 42,
    longestStreak: 7,
    eventCount: 99,
    sessionCount: 12,
    topModels: [
      {
        name: 'gpt-4.1 <fast>',
        totalTokens: 500_000,
        costUsd: 80,
      },
    ],
    topSources: [
      {
        name: 'pi & codex',
        totalTokens: 700_000,
        costUsd: 100,
        costIncomplete: true,
      },
    ],
    monthlyIntensity: Array.from({ length: 12 }, (_, index) => ({
      month: `2026-${String(index + 1).padStart(2, '0')}`,
      totalTokens: index * 100,
      level: Math.min(4, index) as 0 | 1 | 2 | 3 | 4,
    })),
  };
}

describe('renderWrappedShareSvg', () => {
  it('renders stat tiles, top lists, monthly intensity, command badge, and footer', () => {
    const svg = renderWrappedShareSvg(createRecap());

    expect(svg).toContain('<svg');
    expect(svg).toContain('2026 Wrapped');
    expect(svg).toContain('Tokens');
    expect(svg).toContain('Cost');
    expect(svg).toContain('Active Days');
    expect(svg).toContain('Streak');
    expect(svg).toContain('~$123.45');
    expect(svg).toContain('Top Models');
    expect(svg).toContain('Top Sources');
    expect(svg).toContain('Monthly intensity');
    expect(svg).toContain('llm-usage wrapped --year 2026 --share');
    expect(svg).toContain('llm-usage-metrics');
    expect(svg.match(/data-month="/g)).toHaveLength(12);
  });

  it('escapes model and source names', () => {
    const svg = renderWrappedShareSvg(createRecap());

    expect(svg).toContain('gpt-4.1 &lt;fast&gt;');
    expect(svg).toContain('pi &amp; codex');
    expect(svg).not.toContain('gpt-4.1 <fast>');
    expect(svg).not.toContain('pi & codex');
  });

  it('uses singular day label for a one-day streak and shows No data for empty lists', () => {
    const svg = renderWrappedShareSvg({
      ...createRecap(),
      longestStreak: 1,
      topModels: [],
      topSources: [],
    });

    expect(svg).toContain('>day<');
    expect(svg).toContain('No data');
  });
});
