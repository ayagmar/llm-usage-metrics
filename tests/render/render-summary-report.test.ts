import { describe, expect, it } from 'vitest';

import type {
  SummaryDataResult,
  SummaryPeriod,
  UsageWindowTotals,
} from '../../src/cli/usage-data-contracts.js';
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

function createSummaryData(periods?: SummaryPeriod[]): SummaryDataResult {
  return {
    timezone: 'UTC',
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
      createSummaryData([
        period('today', 'Today', '2026-03-10'),
        period('last7Days', 'Last 7 days', '2026-03-04'),
        period('monthToDate', 'Month to date', '2026-03-01'),
      ]),
      'terminal',
      { useColor: false },
    );

    expect(output).toContain(
      'No usage found in the last 7 days or this month. Run `llm-usage doctor`',
    );
  });

  it('renders markdown with each period date range', () => {
    const output = renderSummaryReport(createSummaryData(), 'markdown');

    expect(output).toContain('### Usage summary for 2026-03-10 (UTC)');
    expect(output).toMatch(/\| Today\s+\| 2026-03-10\s+\|/u);
    expect(output).toMatch(/\| Last 7 days\s+\| 2026-03-04 to 2026-03-10 \|/u);
  });

  it('renders JSON without diagnostics', () => {
    const parsed = JSON.parse(renderSummaryReport(createSummaryData(), 'json')) as {
      report: string;
      data: { timezone: string; periods: SummaryPeriod[] };
    };

    expect(parsed.report).toBe('summary');
    expect(parsed.data.timezone).toBe('UTC');
    expect(parsed.data.periods.map((entry) => entry.key)).toEqual([
      'today',
      'last7Days',
      'monthToDate',
    ]);
    expect(Object.keys(parsed.data)).toEqual(['timezone', 'periods']);
  });
});
