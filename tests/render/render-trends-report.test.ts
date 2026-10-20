import { describe, expect, it } from 'vitest';

import type { TrendsReportData } from '../../src/cli/build-trends-data.js';
import type { TrendsDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderTrendsReport } from '../../src/render/render-trends-report.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';
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
  it('renders markdown with one row per date and a total row', () => {
    const output = renderTrendsReport(createTrendsDataResult(), 'markdown');

    expect(output).toContain('| Date');
    expect(output).toContain('Cost |');
    expect(output).toContain('| 2026-03-04 |');
    expect(output).toContain('$1.25');
    expect(output).toContain('~$2.50');
    expect(output).toContain('| Total');
    expect(output).toContain('~$3.75');
  });

  it('renders markdown token columns per source when sourceSeries is present', () => {
    const data = createTrendsDataResult();
    data.metric = 'tokens';
    data.totalSeries = {
      source: 'combined',
      buckets: [
        { date: '2026-03-04', value: 1_500, observed: true },
        { date: '2026-03-05', value: 500, observed: true },
      ],
      summary: {
        total: 2_000,
        average: 1_000,
        peak: { date: '2026-03-04', value: 1_500 },
        incomplete: false,
        observedDayCount: 2,
      },
    };
    data.sourceSeries = [
      {
        source: 'pi',
        buckets: [
          { date: '2026-03-04', value: 1_000, observed: true },
          { date: '2026-03-05', value: 0, observed: false },
        ],
        summary: {
          total: 1_000,
          average: 500,
          peak: { date: '2026-03-04', value: 1_000 },
          incomplete: false,
          observedDayCount: 1,
        },
      },
    ];

    const output = renderTrendsReport(data, 'markdown');

    expect(output).toContain('combined |');
    expect(output).toContain('pi |');
    expect(output).toContain('| 2026-03-04 |');
    expect(output).toContain('1,500');
    expect(output).toContain('1,000');
    expect(output).toContain('| Total');
    expect(output).toContain('2,000');
  });

  it('renders terminal output with title and summary', () => {
    const output = renderTrendsReport(createTrendsDataResult(), 'terminal', {
      useColor: false,
      terminalWidth: 80,
    });

    expect(output).toContain('Daily Cost Trend');
    expect(output).toContain('Total: ~$3.75');
    expect(output).toContain('Peak: ~$2.50 (Mar 06)');
  });

  it('renders active-hours durations with the Active Hours title', () => {
    const data = createTrendsDataResult();
    data.metric = 'active-hours';
    data.totalSeries = {
      source: 'combined',
      buckets: [
        { date: '2026-03-04', value: 8_040_000, observed: true },
        { date: '2026-03-05', value: 0, observed: false },
        { date: '2026-03-06', value: 300_000, observed: true },
      ],
      summary: {
        total: 8_340_000,
        average: 2_780_000,
        peak: { date: '2026-03-04', value: 8_040_000 },
        incomplete: false,
        observedDayCount: 2,
      },
    };

    const output = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 80,
    });

    expect(output).toContain('Daily Active Hours Trend');
    expect(output).toContain('Total: 2h 19m');
    expect(output).toContain('Avg: 46m/day');
    expect(output).toContain('Peak: 2h 14m (Mar 04)');
  });

  it('renders active-hours markdown with an Active column and durations', () => {
    const data = createTrendsDataResult();
    data.metric = 'active-hours';
    data.totalSeries = {
      source: 'combined',
      buckets: [
        { date: '2026-03-04', value: 8_040_000, observed: true },
        { date: '2026-03-05', value: 0, observed: false },
        { date: '2026-03-06', value: 300_000, observed: true },
      ],
      summary: {
        total: 8_340_000,
        average: 2_780_000,
        peak: { date: '2026-03-04', value: 8_040_000 },
        incomplete: false,
        observedDayCount: 2,
      },
    };

    const output = renderTrendsReport(data, 'markdown');

    expect(output).toContain('Active |');
    expect(output).toContain('2h 14m');
    expect(output).toContain('| Total');
    expect(output).toContain('2h 19m');
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
    // An empty range draws no chart axis and no zero totals.
    expect(output).not.toContain('┤');
    expect(output).not.toContain('Total:');
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
    const parsed = JSON.parse(output) as {
      schemaVersion: number;
      report: string;
      data: Record<string, unknown>;
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'trends' });
    expect(parsed.data.metric).toBe('cost');
    expect(parsed.data.dateRange).toEqual({ from: '2026-03-04', to: '2026-03-06' });
    expect(parsed.data).not.toHaveProperty('diagnostics');
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

  it('compresses long empty edges while keeping the full requested range explicit', () => {
    const data = createTrendsDataResult();
    data.metric = 'tokens';
    data.dateRange = {
      from: '2026-03-01',
      to: '2026-03-30',
    };
    data.totalSeries.buckets = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-03-${String(index + 1).padStart(2, '0')}`,
      value: index >= 10 && index < 25 ? index - 9 : 0,
      observed: index >= 10 && index < 25,
    }));
    data.totalSeries.summary = {
      total: data.totalSeries.buckets.reduce((sum, bucket) => sum + bucket.value, 0),
      average:
        data.totalSeries.buckets.reduce((sum, bucket) => sum + bucket.value, 0) /
        data.totalSeries.buckets.length,
      peak: { date: '2026-03-25', value: 15 },
      incomplete: false,
      observedDayCount: 15,
    };

    const output = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 80,
    });

    expect(output).toContain('Daily Token Usage Trend (30 days)');
    expect(output).toContain('Compressed 10 empty days before first activity (Mar 01 to Mar 10).');
    expect(output).toContain('Mar 11');
    expect(output).toContain('Mar 25');
  });

  it('labels the token axis with whole round ticks and leaves no trailing spaces', () => {
    const data = createTrendsDataResult();
    data.metric = 'tokens';
    data.totalSeries.buckets = Array.from({ length: 20 }, (_, index) => ({
      date: `2026-03-${String(index + 1).padStart(2, '0')}`,
      value: index === 5 ? 970 : index === 10 ? 210 : 0,
      observed: index === 5 || index === 10,
    }));
    data.totalSeries.summary = {
      total: 1_180,
      average: 59,
      peak: { date: '2026-03-06', value: 970 },
      incomplete: false,
      observedDayCount: 2,
    };

    const lines = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 80,
    }).split('\n');
    const axisLabels = lines
      .filter((line) => line.includes('┤') || line.includes('┼'))
      .map((line) => line.split(/ [┤┼]/u)[0].trim());

    expect(axisLabels).toEqual(['1K', '750', '500', '250', '0']);
    expect(lines.filter((line) => line !== line.trimEnd())).toEqual([]);
  });

  it('lines up split rows by display width when a label has wide characters', () => {
    const data: TrendsReportData = createTrendsDataResult();
    data.metric = 'tokens';
    const series = (label: string, value: number) => ({
      repoRoot: `/repos/${label}`,
      project: label,
      buckets: [{ date: '2026-03-04', value, observed: true }],
      summary: {
        total: value,
        average: value,
        peak: { date: '2026-03-04', value },
        incomplete: false,
        observedDayCount: 1,
      },
    });
    data.projectSeries = [series('项目', 1_000), series('api', 20)];

    const lines = renderTrendsReport(data, 'terminal', { useColor: false, terminalWidth: 60 })
      .split('\n')
      .filter((line) => line.startsWith('项目') || line.startsWith('api'));

    expect(lines).toHaveLength(2);
    expect(visibleWidth(lines[0])).toBe(visibleWidth(lines[1]));
    expect(lines.map((line) => visibleWidth(line.slice(0, line.indexOf('█') + 1)))).toEqual([8, 8]);
  });

  it('lists spike days under the summary in terminal and markdown output, and narrow terminals', () => {
    const data = createTrendsDataResult();
    data.totalSeries.buckets[2] = { ...data.totalSeries.buckets[2], spike: true };

    for (const output of [
      renderTrendsReport(data, 'terminal', { useColor: false, terminalWidth: 80 }),
      renderTrendsReport(data, 'terminal', { useColor: false, terminalWidth: 30 }),
    ]) {
      expect(output.split('\n').at(-1)).toBe(
        'Spend spikes (3× or more the median active day of the 28 days before, $1.00 minimum): Mar 06 ~$2.50',
      );
    }

    expect(renderTrendsReport(data, 'markdown').split('\n').at(-1)).toBe(
      'Spend spikes (3× or more the median active day of the 28 days before, $1.00 minimum): 2026-03-06 ~$2.50',
    );
    expect(renderTrendsReport(createTrendsDataResult(), 'terminal')).not.toContain('spike');
  });

  it('names only the five largest spike days, in date order, and counts the rest', () => {
    const data = createTrendsDataResult();
    const spikeValues = [10, 70, 20, 60, 50, 30, 40];
    data.totalSeries.buckets = spikeValues.map((value, index) => ({
      date: `2026-03-0${index + 1}`,
      value,
      observed: true,
      spike: true,
    }));
    data.totalSeries.summary = {
      total: 280,
      average: 40,
      peak: { date: '2026-03-02', value: 70 },
      incomplete: false,
      observedDayCount: 7,
    };
    const legend =
      'Spend spikes (3× or more the median active day of the 28 days before, $1.00 minimum): ';

    expect(
      renderTrendsReport(data, 'terminal', { useColor: false, terminalWidth: 80 })
        .split('\n')
        .at(-1),
    ).toBe(
      `${legend}Mar 02 $70.00, Mar 04 $60.00, Mar 05 $50.00, Mar 06 $30.00, Mar 07 $40.00, +2 more`,
    );
    expect(renderTrendsReport(data, 'markdown').split('\n').at(-1)).toBe(
      `${legend}2026-03-02 $70.00, 2026-03-04 $60.00, 2026-03-05 $50.00, 2026-03-06 $30.00, 2026-03-07 $40.00, +2 more`,
    );
  });

  it('labels dates with their year when the range crosses a year', () => {
    const data = createTrendsDataResult();
    data.totalSeries.buckets = [
      { date: '2025-12-30', value: 1, observed: true },
      { date: '2025-12-31', value: 0, observed: false },
      { date: '2026-01-01', value: 0, observed: false },
      { date: '2026-01-02', value: 9, observed: true, spike: true },
    ];
    data.totalSeries.summary = {
      total: 10,
      average: 2.5,
      peak: { date: '2026-01-02', value: 9 },
      incomplete: false,
      observedDayCount: 2,
    };

    const lines = renderTrendsReport(data, 'terminal', {
      useColor: false,
      terminalWidth: 80,
    }).split('\n');

    expect(lines.find((line) => line.includes('2025-12-30'))?.trim()).toMatch(
      /^2025-12-30 +2026-01-02$/,
    );
    expect(lines).toContain('Total: $10.00  |  Avg: $2.50/day  |  Peak: $9.00 (2026-01-02)');
    expect(lines.at(-1)).toMatch(/: 2026-01-02 \$9\.00$/);
  });

  it('draws each day of a short range several columns wide on a wide terminal', () => {
    const data = createTrendsDataResult();
    data.totalSeries.buckets = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-03-${String(index + 1).padStart(2, '0')}`,
      value: index + 1,
      observed: true,
    }));
    data.totalSeries.summary = {
      total: 465,
      average: 15.5,
      peak: { date: '2026-03-30', value: 30 },
      incomplete: false,
      observedDayCount: 30,
    };
    const axisWidth = (terminalWidth: number) => {
      const axis = renderTrendsReport(data, 'terminal', { useColor: false, terminalWidth })
        .split('\n')
        .find((line) => line.includes('┼'));
      return axis?.split('┼')[1]?.length;
    };

    expect(axisWidth(80)).toBe(60);
    expect(axisWidth(200)).toBe(120);
  });

  it('orders by-source rows by total, highest first, and leaves JSON in source order', () => {
    const data = createTrendsDataResult();
    data.metric = 'tokens';
    const sourceSeries = (source: string, total: number) => ({
      source,
      buckets: [{ date: '2026-03-04', value: total, observed: true }],
      summary: {
        total,
        average: total,
        peak: { date: '2026-03-04', value: total },
        incomplete: false,
        observedDayCount: 1,
      },
    });
    data.sourceSeries = [sourceSeries('pi', 10), sourceSeries('codex', 300)];

    const rowLabels = renderTrendsReport(data, 'terminal', { useColor: false, terminalWidth: 80 })
      .split('\n')
      .filter((line) => line.startsWith('pi') || line.startsWith('codex'))
      .map((line) => line.split(' ')[0]);
    const markdownLines = renderTrendsReport(data, 'markdown').split('\n');
    const markdownHeader = markdownLines[0];
    const json = JSON.parse(renderTrendsReport(data, 'json')) as {
      data: { sourceSeries: { source: string }[] };
    };

    expect(rowLabels).toEqual(['codex', 'pi']);
    expect(markdownHeader.indexOf('codex')).toBeLessThan(markdownHeader.indexOf('pi'));
    expect(markdownLines.find((line) => line.includes('2026-03-04'))?.replace(/ +/g, ' ')).toMatch(
      /\| 300 \| 10 \|$/,
    );
    expect(json.data.sourceSeries.map((series) => series.source)).toEqual(['pi', 'codex']);
  });

  it('labels the zero of the active-hours axis 0h', () => {
    const data = createTrendsDataResult();
    data.metric = 'active-hours';
    data.totalSeries.buckets = [
      { date: '2026-03-04', value: 3_600_000, observed: true },
      { date: '2026-03-05', value: 0, observed: false },
    ];
    data.totalSeries.summary = {
      total: 3_600_000,
      average: 1_800_000,
      peak: { date: '2026-03-04', value: 3_600_000 },
      incomplete: false,
      observedDayCount: 1,
    };

    const axis = renderTrendsReport(data, 'terminal', { useColor: false, terminalWidth: 80 })
      .split('\n')
      .find((line) => line.includes('┼'));

    expect(axis?.trimStart().startsWith('0h ┼')).toBe(true);
  });
});
