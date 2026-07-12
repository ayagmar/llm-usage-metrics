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
    costUsd: 123.45,
    costIncomplete: true,
    activeDays: 42,
    longestStreak: 7,
    activeMs: 90 * 60 * 60 * 1000,
    peakHour: { hour: 14, totalTokens: 300_000 },
    weekdayTokens: 900_000,
    weekendTokens: 334_500,
    busiestDay: { date: '2026-03-01', totalTokens: 90_000 },
    estimatedCacheSavingsUsd: 42.5,
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
    dailyIntensity: Array.from({ length: 365 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
      return { date, totalTokens: index % 5, level: (index % 5) as 0 | 1 | 2 | 3 | 4 };
    }),
  };
}

describe('renderWrappedShareSvg', () => {
  it('renders stat tiles, top lists, daily heatmap, command badge, and footer', () => {
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
    expect(svg).toContain('Daily activity');
    expect(svg).toContain('llm-usage wrapped --year 2026 --share');
    expect(svg).toContain('llm-usage-metrics');
    expect(svg.match(/data-date="/g)).toHaveLength(365);
  });

  it('escapes model and source names', () => {
    const svg = renderWrappedShareSvg(createRecap());

    expect(svg).toContain('gpt-4.1 &lt;fast&gt;');
    expect(svg).toContain('pi &amp; codex');
    expect(svg).not.toContain('gpt-4.1 <fast>');
    expect(svg).not.toContain('pi & codex');
  });

  it('renders at most three rows per top list even when the recap carries five', () => {
    const svg = renderWrappedShareSvg({
      ...createRecap(),
      topModels: Array.from({ length: 5 }, (_, index) => ({
        name: `model-${index}`,
        totalTokens: (5 - index) * 100,
        costUsd: 5 - index,
      })),
    });

    expect(svg.match(/data-top-item="Top Models-\d+"/g)).toHaveLength(3);
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
