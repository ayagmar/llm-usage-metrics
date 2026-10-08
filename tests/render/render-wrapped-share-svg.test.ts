import { describe, expect, it } from 'vitest';

import { renderWrappedShareSvg } from '../../src/render/render-wrapped-share-svg.js';
import { shareThemes } from '../../src/render/share-svg-theme.js';
import type { WrappedRecap } from '../../src/wrapped/wrapped-recap.js';
import { HOSTILE_TEXT, renderInBothThemes } from './share-svg-assertions.js';

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
  it('renders the stats, a Monday-first year grid, and the top lists in both themes', () => {
    const [svg] = renderInBothThemes((theme) => renderWrappedShareSvg(createRecap(), theme));

    expect(svg).toContain('2026 Wrapped');
    expect([...svg.matchAll(/data-stat="([^"]+)"/gu)].map((match) => match[1])).toEqual([
      'Cost',
      'Tokens',
      'Hours',
      'Active days',
      'Longest streak',
    ]);
    expect(svg).toContain('~$123.45');
    expect(svg).toContain('cache saved ~$42.50');
    expect(svg).toContain('>90<');
    expect(svg).toContain('12 sessions');
    expect(svg).toContain('Top models');
    expect(svg).toContain('Top sources');
    expect(svg).toContain('$ llm-usage wrapped --year 2026 --share');
    expect(svg).toContain('2026-01-01 to 2026-12-31');
    expect(svg.match(/data-date="/gu)).toHaveLength(365);
    // 2026-01-01 is a Thursday: the fourth row of the first week column.
    expect(svg).toMatch(/data-date="2026-01-01" data-level="0" x="100" y="329"/u);
    expect(svg).toMatch(/data-date="2026-01-05" data-level="4" x="119" y="272"/u);
  });

  it('colors heatmap cells from each theme', () => {
    for (const theme of [shareThemes.dark, shareThemes.light]) {
      const svg = renderWrappedShareSvg(createRecap(), theme);

      expect(svg).toMatch(
        new RegExp(`data-date="2026-01-05" data-level="4"[^>]*fill="${theme.heat[4]}"`, 'u'),
      );
    }
  });

  it('escapes and shortens hostile model and source names', () => {
    const [svg] = renderInBothThemes((theme) =>
      renderWrappedShareSvg(
        {
          ...createRecap(),
          topModels: [{ name: HOSTILE_TEXT, totalTokens: 1, costUsd: 1 }],
          topSources: [{ name: 'pi & codex', totalTokens: 1 }],
        },
        theme,
      ),
    );

    expect(svg).not.toContain('<script');
    expect(svg).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
    expect(svg).toContain('pi &amp; codex');

    const longName = renderWrappedShareSvg(
      { ...createRecap(), topModels: [{ name: 'm'.repeat(80), totalTokens: 1 }] },
      shareThemes.dark,
    );
    expect(longName).toContain(`${'m'.repeat(33)}…`);
  });

  it('shows the top three rows of each list even when the recap carries five', () => {
    const svg = renderWrappedShareSvg(
      {
        ...createRecap(),
        topModels: Array.from({ length: 5 }, (_, index) => ({
          name: `model-${index}`,
          totalTokens: (5 - index) * 100,
          costUsd: 5 - index,
        })),
      },
      shareThemes.dark,
    );

    expect(svg.match(/data-top-item="Top models-\d+"/gu)).toHaveLength(3);
  });

  it('uses a singular day unit and shows No data for empty lists', () => {
    const svg = renderWrappedShareSvg(
      { ...createRecap(), longestStreak: 1, topModels: [], topSources: [] },
      shareThemes.dark,
    );

    expect(svg).toContain('>day</tspan>');
    expect(svg.match(/No data/gu)).toHaveLength(2);
  });

  it('shows an empty state for a year without usage', () => {
    const [svg] = renderInBothThemes((theme) =>
      renderWrappedShareSvg({ ...createRecap(), eventCount: 0 }, theme),
    );

    expect(svg).toContain('No usage in 2026');
    expect(svg).not.toContain('data-date=');
  });
});
