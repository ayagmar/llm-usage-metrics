import { describe, expect, it } from 'vitest';

import type { TrendsDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderTrendsReport } from '../../src/render/render-trends-report.js';
import { overrideStdoutTty } from '../helpers/stdout.js';

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
    expect(output).toContain('▄ █');
    expect(output).not.toContain('▄▁█');
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

  it('keeps the no-data note in summary-only output on narrow terminals', () => {
    const data = createTrendsDataResult();
    data.totalSeries.buckets = [{ date: '2026-03-04', value: 0, observed: false }];
    data.totalSeries.summary = {
      total: 0,
      average: 0,
      peak: { date: '', value: 0 },
      incomplete: false,
      observedDayCount: 0,
    };

    const output = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 20,
    });

    expect(output).toContain('No usage data found for the selected date range.');
  });

  it('uses stdout tty width when no terminal width override is provided', () => {
    const restoreStdout = overrideStdoutTty(20);

    try {
      const output = renderTrendsReport(createTrendsDataResult(), 'terminal');
      expect(output).toContain('Terminal is too narrow for chart rendering');
    } finally {
      restoreStdout();
    }
  });

  it('keeps the unresolved-cost note in summary-only output on narrow terminals', () => {
    const data = createTrendsDataResult();
    data.totalSeries.buckets = [
      { date: '2026-03-04', value: 0, observed: true, incomplete: true },
      { date: '2026-03-05', value: 0, observed: false },
      { date: '2026-03-06', value: 0, observed: true, incomplete: true },
    ];
    data.totalSeries.summary = {
      total: 0,
      average: 0,
      peak: { date: '2026-03-04', value: 0 },
      incomplete: true,
      observedDayCount: 2,
    };

    const output = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 20,
    });

    expect(output).toContain(
      'No resolved cost data for the selected range; use pricing or switch to --metric tokens.',
    );
  });

  it('shows the unresolved-cost note in normal-width output too', () => {
    const data = createTrendsDataResult();
    data.totalSeries.buckets = [
      { date: '2026-03-04', value: 0, observed: true, incomplete: true },
      { date: '2026-03-05', value: 0, observed: false },
      { date: '2026-03-06', value: 0, observed: true, incomplete: true },
    ];
    data.totalSeries.summary = {
      total: 0,
      average: 0,
      peak: { date: '2026-03-04', value: 0 },
      incomplete: true,
      observedDayCount: 2,
    };

    const output = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 80,
    });

    expect(output).toContain(
      'No resolved cost data for the selected range; use pricing or switch to --metric tokens.',
    );
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

  it('renders blank by-source sparklines when a source has no non-zero buckets', () => {
    const data = createTrendsDataResult();
    data.metric = 'tokens';
    data.totalSeries.summary.incomplete = false;
    data.sourceSeries = [
      {
        source: 'pi',
        buckets: [
          { date: '2026-03-04', value: 0, observed: false },
          { date: '2026-03-05', value: 0, observed: false },
          { date: '2026-03-06', value: 0, observed: false },
        ],
        summary: {
          total: 0,
          average: 0,
          peak: { date: '', value: 0 },
          incomplete: false,
          observedDayCount: 0,
        },
      },
    ];

    const output = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 80,
    });

    expect(output).toContain('pi');
    expect(output).toContain(' 0');
    expect(output).not.toContain('▁');
  });

  it('keeps exact peak values unprefixed when only non-peak days are incomplete', () => {
    const data = createTrendsDataResult();
    data.totalSeries.buckets = [
      { date: '2026-03-04', value: 3, observed: true },
      { date: '2026-03-05', value: 0, observed: false },
      { date: '2026-03-06', value: 1, observed: true, incomplete: true },
    ];
    data.totalSeries.summary = {
      total: 4,
      average: 4 / 3,
      peak: { date: '2026-03-04', value: 3 },
      incomplete: true,
      observedDayCount: 2,
    };

    const output = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 80,
    });

    expect(output).toContain('Total: ~$4.00');
    expect(output).toContain('Peak: $3.00 (Mar 04)');
    expect(output).not.toContain('Peak: ~$3.00');
  });

  it('renders JSON without diagnostics', () => {
    const output = renderTrendsReport(createTrendsDataResult(), 'json');
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(parsed.metric).toBe('cost');
    expect(parsed.dateRange).toEqual({ from: '2026-03-04', to: '2026-03-06' });
    expect(parsed).not.toHaveProperty('diagnostics');
  });

  it('renders a midpoint date label on wider combined charts', () => {
    const data = createTrendsDataResult();
    data.totalSeries.buckets = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-03-${String(index + 1).padStart(2, '0')}`,
      value: index + 1,
      observed: true,
    }));
    data.totalSeries.summary = {
      total: data.totalSeries.buckets.reduce((sum, bucket) => sum + bucket.value, 0),
      average:
        data.totalSeries.buckets.reduce((sum, bucket) => sum + bucket.value, 0) /
        data.totalSeries.buckets.length,
      peak: { date: '2026-03-30', value: 30 },
      incomplete: false,
      observedDayCount: 30,
    };

    const output = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 80,
    });

    expect(output).toContain('Mar 16');
  });

  it('keeps non-zero early activity visible when a later spike dominates the chart scale', () => {
    const data = createTrendsDataResult();
    data.metric = 'tokens';
    data.totalSeries.buckets = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      value: index === 2 ? 50 : index === 14 ? 80 : index === 29 ? 1_000 : 0,
      observed: true,
    }));
    data.totalSeries.summary = {
      total: 1_130,
      average: 1_130 / 30,
      peak: { date: '2026-01-30', value: 1_000 },
      incomplete: false,
      observedDayCount: 30,
    };

    const output = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 40,
    });
    const chartLines = output
      .split('\n')
      .filter((line) => line.includes('┤') || line.includes('┼'));
    const bottomDataRow = chartLines.at(-2) ?? '';

    expect(bottomDataRow).toContain('▂');
    expect(bottomDataRow.trimEnd().endsWith('█')).toBe(true);
  });
});
