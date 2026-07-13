import { describe, expect, it } from 'vitest';

import type { TrendsDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderTrendsShareSvg } from '../../src/render/render-trends-share-svg.js';
import type { TrendSeries } from '../../src/trends/trends-series.js';

function createData(): TrendsDataResult {
  return {
    metric: 'tokens',
    dateRange: {
      from: '2026-03-04',
      to: '2026-03-06',
    },
    totalSeries: {
      source: 'combined <all>' as unknown as TrendSeries['source'],
      buckets: [
        { date: '2026-03-04', value: 1200, observed: true },
        { date: '2026-03-05', value: 0, observed: false },
        { date: '2026-03-06', value: 2400, observed: true },
      ],
      summary: {
        total: 3600,
        average: 1200,
        peak: { date: '2026-03-06', value: 2400 },
        incomplete: false,
        observedDayCount: 2,
      },
    },
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

describe('renderTrendsShareSvg', () => {
  it('renders a combined trends SVG with title, day span, line path, stats, and footer', () => {
    const svg = renderTrendsShareSvg(createData());

    expect(svg).toContain('<svg');
    expect(svg).toContain('Daily Token Usage Trend');
    expect(svg).toContain('3 days - 2026-03-04 to 2026-03-06');
    expect(svg).toContain('Total');
    expect(svg).toContain('Peak');
    expect(svg).toContain('Min');
    expect(svg).toContain('llm-usage trends --share');
    expect(svg).toContain('llm-usage-metrics');
    expect(svg.match(/data-series="combined"/g)).toHaveLength(1);
  });

  it('escapes the rendered series label', () => {
    const svg = renderTrendsShareSvg(createData());

    expect(svg).toContain('· combined &lt;all&gt;');
    expect(svg).not.toContain('combined <all>');
  });

  it('renders an active-hours trend with duration labels', () => {
    const data = createData();
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

    const svg = renderTrendsShareSvg(data);

    expect(svg).toContain('Daily Active Hours Trend');
    expect(svg).toContain('2h 19m');
  });

  it('renders a single-day cost trend as one marker', () => {
    const data = createData();
    data.metric = 'cost';
    data.dateRange = {
      from: '2026-03-04',
      to: '2026-03-04',
    };
    data.totalSeries = {
      source: 'combined',
      buckets: [{ date: '2026-03-04', value: 12.34, observed: true, incomplete: true }],
      summary: {
        total: 12.34,
        average: 12.34,
        peak: { date: '2026-03-04', value: 12.34 },
        incomplete: true,
        observedDayCount: 1,
      },
    };

    const svg = renderTrendsShareSvg(data);

    expect(svg).toContain('Daily Cost Trend');
    expect(svg).toContain('1 day - 2026-03-04');
    expect(svg).toContain('~$12.34');
    expect(svg).toContain('<circle data-series="combined"');
  });

  it('renders an empty-state SVG without date labels', () => {
    const data = createData();
    data.totalSeries = {
      source: 'combined',
      buckets: [],
      summary: {
        total: 0,
        average: 0,
        peak: { date: '', value: 0 },
        incomplete: false,
        observedDayCount: 0,
      },
    };

    const svg = renderTrendsShareSvg(data);

    expect(svg).toContain('No trend data available');
    expect(svg).toContain('0 days - 2026-03-04 to 2026-03-06');
  });
});
