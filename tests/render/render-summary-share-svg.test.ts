import { describe, expect, it } from 'vitest';

import {
  aggregateDailyActivity,
  resolveActivityStart,
} from '../../src/aggregate/daily-activity.js';
import type { SummaryDataResult, UsageWindowTotals } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { renderSummaryShareSvg } from '../../src/render/render-summary-share-svg.js';
import { shareThemes } from '../../src/render/share-svg-theme.js';
import { renderInBothThemes } from './share-svg-assertions.js';

const TODAY = '2026-03-10';

function totals(overrides: Partial<UsageWindowTotals> = {}): UsageWindowTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    events: 0,
    activeDays: 0,
    ...overrides,
  };
}

function createSummaryData(dates: string[]): SummaryDataResult {
  const events = dates.map((date, index) =>
    createUsageEvent({
      source: 'codex',
      sessionId: 'session-1',
      timestamp: `${date}T09:00:00.000Z`,
      provider: 'openai',
      model: 'gpt-4.1',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 1_000 * (index + 1),
      costMode: 'explicit',
      costUsd: index + 1,
    }),
  );

  return {
    timezone: 'Europe/Paris',
    monthEnd: { daysElapsed: 10, daysInMonth: 31 },
    periods: [
      {
        key: 'monthToDate',
        label: 'Month to date',
        since: '2026-03-01',
        until: TODAY,
        totals: totals({ totalTokens: 2_500_000, costUsd: 12.5, costIncomplete: true }),
        sources: [],
      },
    ],
    activity: aggregateDailyActivity(events, {
      from: resolveActivityStart(TODAY),
      to: TODAY,
      timezone: 'UTC',
    }),
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

describe('renderSummaryShareSvg', () => {
  it('leads with the current streak and shows the year grid in both themes', () => {
    const [svg] = renderInBothThemes((theme) =>
      renderSummaryShareSvg(createSummaryData(['2026-03-07', '2026-03-09', TODAY]), theme),
    );

    expect(svg).toContain('LLM usage activity');
    expect(svg).toContain('Past 12 months, Europe/Paris time');
    expect([...svg.matchAll(/data-stat="([^"]+)"/gu)].map((match) => match[1])).toEqual([
      'Current streak',
      'Longest streak',
      'Best day',
      'This month',
    ]);
    // The streak figure is the accent; its unit follows in a smaller tspan.
    expect(svg).toContain(`fill="${shareThemes.dark.accent}"`);
    expect(svg).toMatch(/>2<tspan[^>]*>days<\/tspan>/u);
    expect(svg).toContain('>Mar 10<');
    expect(svg).toContain('~$12.50');
    expect(svg).toContain('3 active days');
    expect(svg).toContain('$ llm-usage summary --share');
    expect(svg).toContain('2025-03-10 to 2026-03-10');
    expect(svg.match(/data-date="/gu)).toHaveLength(366);
    expect(svg).toContain('data-heat-legend="true"');
  });

  it('places the last day in the bottom-right week column', () => {
    const svg = renderSummaryShareSvg(createSummaryData([TODAY]), shareThemes.dark);

    // 53 week columns of 19px from x=100; Tuesday is the second row.
    expect(svg).toMatch(/data-date="2026-03-10" data-level="1" x="1088" y="371"/u);
    expect(svg).toMatch(/data-date="2025-03-10" data-level="0" x="100" y="352"/u);
  });

  it('keeps a six-figure month-to-date cost inside the right margin', () => {
    const data = createSummaryData([TODAY]);
    data.periods[0].totals.costUsd = 123_456.78;

    const svg = renderSummaryShareSvg(data, shareThemes.dark);

    // Twelve 34px monospace glyphs (about 0.6em each) from x=886 end before the 1136 margin.
    expect(svg).toMatch(/<text x="886" y="214"[^>]*>~\$123,456\.78</u);
    expect(886 + 12 * 34 * 0.6).toBeLessThan(1136);
  });

  it('uses singular units and a dash for a missing best day', () => {
    const single = renderSummaryShareSvg(createSummaryData([TODAY]), shareThemes.dark);
    expect(single).toMatch(/>1<tspan[^>]*>day<\/tspan>/u);

    const data = createSummaryData([TODAY]);
    const noBestDay = renderSummaryShareSvg(
      { ...data, activity: { ...data.activity, bestDay: undefined } },
      shareThemes.dark,
    );
    expect(noBestDay).toMatch(/data-stat="Best day">[\s\S]*?>-<\/text>/u);
  });

  it('shows an empty state without usage in the past year', () => {
    const [svg] = renderInBothThemes((theme) =>
      renderSummaryShareSvg(createSummaryData([]), theme),
    );

    expect(svg).toContain('No usage in the past year');
    expect(svg).not.toContain('data-date=');
  });
});
