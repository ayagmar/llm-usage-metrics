import { describe, expect, it } from 'vitest';

import type {
  SummaryDataResult,
  SummaryPeriod,
  UsageWindowTotals,
} from '../../src/cli/usage-data-contracts.js';
import {
  aggregateDailyActivity,
  resolveActivityStart,
} from '../../src/aggregate/daily-activity.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { renderSummaryReport } from '../../src/render/render-summary-report.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';

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

function period(
  key: SummaryPeriod['key'],
  label: string,
  since: string,
  overrides: Partial<SummaryPeriod> = {},
): SummaryPeriod {
  return { key, label, since, until: '2026-03-10', totals: totals(), sources: [], ...overrides };
}

function activityFor(dates: string[]): SummaryDataResult['activity'] {
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

  return aggregateDailyActivity(events, {
    from: resolveActivityStart('2026-03-10'),
    to: '2026-03-10',
    timezone: 'UTC',
  });
}

function createSummaryData(
  periods?: SummaryPeriod[],
  activity = activityFor(['2026-03-07', '2026-03-09', '2026-03-10']),
): SummaryDataResult {
  return {
    timezone: 'UTC',
    monthEnd: { daysElapsed: 10, daysInMonth: 31 },
    activity,
    periods: periods ?? [
      period('today', 'Today', '2026-03-10', {
        totals: totals({ totalTokens: 1_500, costUsd: 5, events: 2, activeDays: 1 }),
        sources: [
          { source: 'claude', ...totals({ totalTokens: 1_000, costUsd: 4, events: 1 }) },
          { source: 'codex', ...totals({ totalTokens: 500, costUsd: 1, events: 1 }) },
        ],
      }),
      period('last7Days', 'Last 7 days', '2026-03-04', {
        totals: totals({ totalTokens: 1_234_567, costUsd: 12.5, costIncomplete: true }),
        sources: [{ source: 'pi', ...totals({ totalTokens: 1_234_567, costUsd: 12.5 }) }],
      }),
      period('monthToDate', 'Month to date', '2026-03-01', {
        totals: totals({ totalTokens: 42 }),
        sources: [{ source: 'gemini', ...totals({ totalTokens: 42 }) }],
      }),
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

describe('renderSummaryReport', () => {
  it('renders one row per period in under 80 columns', () => {
    const output = renderSummaryReport(createSummaryData(), 'terminal', { useColor: false });
    const lines = output.split('\n');

    expect(output).toContain('Usage summary for 2026-03-10 (UTC)');
    expect(lines.find((line) => line.includes('Today'))).toMatch(
      /Today\s+│\s+\$5\.00 │\s+1,500 │ claude \(80%\)/u,
    );
    expect(lines.find((line) => line.includes('Last 7 days'))).toMatch(
      /~\$12\.50 │\s+1,234,567 │ pi \(~100%\)/u,
    );
    // No resolved cost: no share, just the source.
    expect(lines.find((line) => line.includes('Month to date'))).toMatch(/-\s+│\s+42 │ gemini/u);
    expect(Math.max(...lines.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(80);
  });

  it('points to doctor when there is no usage at all', () => {
    const output = renderSummaryReport(
      createSummaryData(
        [
          period('today', 'Today', '2026-03-10'),
          period('last7Days', 'Last 7 days', '2026-03-04'),
          period('monthToDate', 'Month to date', '2026-03-01'),
        ],
        activityFor([]),
      ),
      'terminal',
      { useColor: false },
    );

    expect(output).toContain(
      'No usage found in the last 7 days or this month. Run `llm-usage doctor`',
    );
    // An empty year draws no activity section.
    expect(output).not.toContain('Activity');
  });

  it('renders streaks, the best day, and a weekday-by-week heatmap', () => {
    const output = renderSummaryReport(createSummaryData(), 'terminal', { useColor: false });
    const lines = output.split('\n');

    expect(output).toContain('Activity since 2025-03-10');
    expect(lines).toContain('Current streak  2 days');
    expect(lines).toContain('Longest streak  2 days');
    expect(lines).toContain('Best day        2026-03-10 · $3.00 · 3k tokens');
    expect(lines).toContain('Active days     3');

    const rows = lines.filter((line) => /^(?:Mon|Wed|Fri| {3}) [·░▒▓█]/u.test(line));
    expect(rows).toHaveLength(7);
    // 53 weeks; the current week ends on Tuesday 2026-03-10.
    expect(rows[0]).toHaveLength(4 + 53);
    expect(rows[0].endsWith('▒')).toBe(true); // Mon 03-09
    expect(rows[1].endsWith('█')).toBe(true); // Tue 03-10
    expect(rows[2]).toHaveLength(4 + 52); // Wed 03-11 is in the future
    expect(rows[5].endsWith('░')).toBe(true); // Sat 03-07
    expect(output).toContain('Less ·░▒▓█ More');
  });

  it('keeps the most recent weeks that fit a narrow terminal', () => {
    const narrow = renderSummaryReport(createSummaryData(), 'terminal', {
      useColor: false,
      terminalWidth: 40,
    });
    const tooNarrow = renderSummaryReport(createSummaryData(), 'terminal', {
      useColor: false,
      terminalWidth: 16,
    });
    const heatmapRow = (output: string) =>
      output.split('\n').find((line) => line.startsWith('Mon ')) ?? '';

    expect(heatmapRow(narrow)).toHaveLength(40);
    expect(heatmapRow(narrow).endsWith('▒')).toBe(true);
    expect(heatmapRow(tooNarrow)).toBe('');
    expect(tooNarrow).toContain('Current streak  2 days');
  });

  it('never draws the heatmap or its legend past the terminal width', () => {
    for (const terminalWidth of [17, 18, 19, 20, 57, 80]) {
      const output = renderSummaryReport(createSummaryData(), 'terminal', {
        useColor: true,
        terminalWidth,
      });
      const activityLines = output
        .split('\n')
        .slice(output.split('\n').findIndex((line) => line.includes('Active days')) + 1);

      for (const line of activityLines) {
        expect(visibleWidth(line), `${terminalWidth}: ${line}`).toBeLessThanOrEqual(terminalWidth);
      }
    }
  });

  it('colors heatmap cells by level when color is on', () => {
    const output = renderSummaryReport(createSummaryData(), 'terminal', {
      useColor: true,
      palette: {
        cyan: (text) => text,
        magenta: (text) => text,
        blue: (text) => text,
        yellow: (text) => text,
        white: (text) => text,
        bold: (text) => `*${text}*`,
        green: (text) => `<${text}>`,
        dim: (text) => `_${text}_`,
      },
    });

    expect(output).toContain('*<█>*');
    expect(output).toContain('<░>');
    expect(output).toContain('_·_');
  });

  it('stays quiet about a budget when the month has no usage yet', () => {
    const output = renderSummaryReport(
      { ...createSummaryData(), monthEnd: { daysElapsed: 10, daysInMonth: 31, budgetUsd: 100 } },
      'terminal',
      { useColor: false },
    );

    expect(output).not.toContain('budget');
  });

  it('says nothing about the month without a projection, budget, or savings', () => {
    const output = renderSummaryReport(createSummaryData(), 'terminal', { useColor: false });

    expect(output).not.toContain('On pace');
    expect(output).not.toContain('budget');
    expect(output).not.toContain('Prompt caching');
  });

  it('shows the projection, budget status, and cache savings under the table', () => {
    const withMonth = (
      monthEnd: SummaryDataResult['monthEnd'],
      monthToDateCacheSavingsUsd?: number,
    ) => {
      const data = createSummaryData();
      data.periods[2].totals.costUsd = 40;
      data.periods[2].totals.events = 4;
      return renderSummaryReport({ ...data, monthEnd, monthToDateCacheSavingsUsd }, 'terminal', {
        useColor: false,
      }).split('\n');
    };
    const base = { daysElapsed: 10, daysInMonth: 31 };

    expect(withMonth({ ...base, projectedCostUsd: 124, costIncomplete: true }, 12.5)).toEqual(
      expect.arrayContaining([
        'On pace for ~$124.00 this month',
        'Prompt caching saved you ~$12.50 this month',
      ]),
    );
    expect(withMonth({ ...base, projectedCostUsd: 124, budgetUsd: 100 })).toContain(
      '⚠ On pace to exceed your $100.00 monthly budget by $24.00',
    );
    expect(withMonth({ ...base, projectedCostUsd: 124, budgetUsd: 30 })).toContain(
      '⚠ Over your $30.00 monthly budget: $40.00 spent',
    );
    // Spend without any known price is unknown, not within budget.
    const unpriced = createSummaryData();
    unpriced.periods[2].totals.events = 4;
    expect(
      renderSummaryReport({ ...unpriced, monthEnd: { ...base, budgetUsd: 500 } }, 'terminal', {
        useColor: false,
      }).split('\n'),
    ).toContain("Monthly budget $500.00: this month's cost is unknown (no pricing for its usage)");
    // Before day 3 there is no projection, but the budget still reports what was spent.
    expect(withMonth({ ...base, budgetUsd: 500 })).toContain(
      'Within your $500.00 monthly budget ($40.00 spent)',
    );
  });

  it('colors budget warnings when color is on', () => {
    const data = createSummaryData();
    data.periods[2].totals.costUsd = 0.5;
    data.periods[2].totals.events = 2;
    const output = renderSummaryReport(
      {
        ...data,
        monthEnd: { daysElapsed: 10, daysInMonth: 31, projectedCostUsd: 200, budgetUsd: 1 },
      },
      'terminal',
      {
        useColor: true,
        palette: {
          cyan: (text) => text,
          magenta: (text) => text,
          blue: (text) => text,
          yellow: (text) => `<y>${text}</y>`,
          white: (text) => text,
          bold: (text) => text,
          green: (text) => text,
          dim: (text) => text,
        },
      },
    );

    expect(output).toContain('<y>⚠ On pace to exceed your $1.00 monthly budget by $199.00</y>');
  });

  it('renders markdown with each period date range', () => {
    const output = renderSummaryReport(createSummaryData(), 'markdown');

    expect(output).toContain('### Usage summary for 2026-03-10 (UTC)');
    expect(output).toMatch(/\| Today\s+\| 2026-03-10\s+\|/u);
    expect(output).toMatch(/\| Last 7 days\s+\| 2026-03-04 to 2026-03-10 \|/u);
    expect(output).toContain('#### Activity since 2025-03-10');
    const markdownData = createSummaryData();
    markdownData.periods[2].totals.costUsd = 3;
    markdownData.periods[2].totals.events = 2;
    const withBudget = renderSummaryReport(
      {
        ...markdownData,
        monthEnd: { daysElapsed: 10, daysInMonth: 31, projectedCostUsd: 9, budgetUsd: 5 },
      },
      'markdown',
    );
    expect(withBudget).toContain('On pace for $9.00 this month');
    expect(withBudget).toContain('⚠ On pace to exceed your $5.00 monthly budget by $4.00');
    expect(output).toMatch(/\| Current streak \|\s+2 days \|/u);
    expect(output).toMatch(/\| Best day\s+\| 2026-03-10 · \$3\.00 · 3k tokens \|/u);
  });

  it('renders JSON without diagnostics', () => {
    const parsed = JSON.parse(renderSummaryReport(createSummaryData(), 'json')) as {
      report: string;
      data: {
        timezone: string;
        periods: SummaryPeriod[];
        activity: SummaryDataResult['activity'];
      };
    };

    expect(parsed.report).toBe('summary');
    expect(parsed.data.timezone).toBe('UTC');
    expect(parsed.data.periods.map((entry) => entry.key)).toEqual([
      'today',
      'last7Days',
      'monthToDate',
    ]);
    expect(Object.keys(parsed.data)).toEqual(['timezone', 'periods', 'monthEnd', 'activity']);
    expect(parsed.data.activity).toMatchObject({ currentStreak: 2, longestStreak: 2 });
    expect(parsed.data.activity.days).toHaveLength(366);
  });
});
