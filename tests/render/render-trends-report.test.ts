import { describe, expect, it } from 'vitest';

import type { TrendsDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderTrendsReport } from '../../src/render/render-trends-report.js';

function createTrendsDataResult(): TrendsDataResult {
  return {
    metric: 'cost',
    dateRange: {
      from: '2026-03-04',
      to: '2026-03-06',
    },
    totalSeries: {
      source: 'combined',
      buckets: [
        { date: '2026-03-04', value: 1.25, observed: true },
        { date: '2026-03-05', value: 0, observed: false },
        { date: '2026-03-06', value: 2.5, observed: true, incomplete: true },
      ],
      summary: {
        total: 3.75,
        average: 1.25,
        peak: { date: '2026-03-06', value: 2.5 },
        incomplete: true,
        observedDayCount: 2,
      },
    },
    diagnostics: {
      sessionStats: [],
      sourceFailures: [],
      skippedRows: [],
      pricingOrigin: 'cache',
      activeEnvOverrides: [],
      timezone: 'UTC',
    },
  };
}

describe('renderTrendsReport', () => {
  it('renders terminal output with title and summary', () => {
    const output = renderTrendsReport(createTrendsDataResult(), 'terminal', {
      useColor: false,
      terminalWidth: 80,
    });

    expect(output).toContain('Daily Cost Trend');
    expect(output).toContain('Total: ~$3.75');
    expect(output).toContain('Peak: ~$2.50 (Mar 06)');
  });

  it('renders by-source rows in terminal mode', () => {
    const data = createTrendsDataResult();
    data.metric = 'tokens';
    data.totalSeries.summary.incomplete = false;
    data.sourceSeries = [
      {
        source: 'pi',
        buckets: [
          { date: '2026-03-04', value: 10, observed: true },
          { date: '2026-03-05', value: 0, observed: false },
          { date: '2026-03-06', value: 20, observed: true },
        ],
        summary: {
          total: 30,
          average: 10,
          peak: { date: '2026-03-06', value: 20 },
          incomplete: false,
          observedDayCount: 2,
        },
      },
    ];

    const output = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 80,
    });

    expect(output).toContain('pi');
    expect(output).toContain('30');
  });

  it('renders a no-data note when there are no observed buckets', () => {
    const data = createTrendsDataResult();
    data.totalSeries.buckets = [
      { date: '2026-03-04', value: 0, observed: false },
      { date: '2026-03-05', value: 0, observed: false },
    ];
    data.totalSeries.summary = {
      total: 0,
      average: 0,
      peak: { date: '2026-03-04', value: 0 },
      incomplete: false,
      observedDayCount: 0,
    };

    const output = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 80,
    });

    expect(output).toContain('No usage data found for the selected date range.');
    expect(output).not.toContain('Peak:');
  });

  it('falls back to summary-only output on narrow terminals', () => {
    const output = renderTrendsReport(createTrendsDataResult(), 'terminal', {
      useColor: false,
      terminalWidth: 20,
    });

    expect(output).toContain('Terminal is too narrow for chart rendering');
    expect(output).toContain('Total: ~$3.75');
  });

  it('does not claim by-source mode when there are no source rows to render', () => {
    const data = createTrendsDataResult();
    data.sourceSeries = [];

    const output = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 80,
    });

    expect(output).toContain('Daily Cost Trend (3 days)');
    expect(output).not.toContain('Daily Cost Trend by Source');
  });

  it('renders JSON without diagnostics', () => {
    const output = renderTrendsReport(createTrendsDataResult(), 'json');
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(parsed.metric).toBe('cost');
    expect(parsed.dateRange).toEqual({ from: '2026-03-04', to: '2026-03-06' });
    expect(parsed).not.toHaveProperty('diagnostics');
  });
});
