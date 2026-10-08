import { describe, expect, it } from 'vitest';

import type { TrendsDataResult } from '../../src/cli/usage-data-contracts.js';
import { renderTrendsShareSvg } from '../../src/render/render-trends-share-svg.js';
import { shareThemes } from '../../src/render/share-svg-theme.js';
import { renderInBothThemes } from './share-svg-assertions.js';

function createData(): TrendsDataResult {
  return {
    metric: 'tokens',
    dateRange: {
      from: '2026-03-04',
      to: '2026-03-06',
    },
    totalSeries: {
      source: 'combined <all>',
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

const dark = shareThemes.dark;

function barFor(svg: string, date: string): string {
  return (
    /<rect data-date="[^"]+"[^>]*>/u.exec(
      svg.slice(svg.indexOf(`<rect data-date="${date}"`)),
    )?.[0] ?? ''
  );
}

describe('renderTrendsShareSvg', () => {
  it('renders summary stats and one bar per day in both themes', () => {
    const [svg] = renderInBothThemes((theme) => renderTrendsShareSvg(createData(), theme));

    expect(svg).toContain('Daily tokens');
    // The series label is escaped.
    expect(svg).toContain('3 days of combined &lt;all&gt;');
    expect([...svg.matchAll(/data-stat="([^"]+)"/gu)].map((match) => match[1])).toEqual([
      'Total',
      'Daily average',
      'Peak',
      'Lowest',
    ]);
    expect(svg).toContain('>3.6k<');
    expect(svg).toContain('$ llm-usage trends --share');
    expect(svg).toContain('2026-03-04 to 2026-03-06');
    expect(svg.match(/<rect data-date="/gu)).toHaveLength(3);
  });

  it('shades bars by quartile, with the peak in the accent and missing days faint', () => {
    const svg = renderTrendsShareSvg(createData(), dark);

    expect(barFor(svg, '2026-03-06')).toContain(`fill="${dark.heat[4]}"`);
    expect(barFor(svg, '2026-03-04')).not.toContain('fill-opacity');
    expect(barFor(svg, '2026-03-05')).toContain('fill-opacity="0.4"');
  });

  it('anchors the first and last date labels to the chart edges', () => {
    const svg = renderTrendsShareSvg(createData(), dark);

    expect(svg).toMatch(/<text x="124" y="526" font-size="13"[^>]*>2026-03-04</u);
    expect(svg).toMatch(/<text x="1136" y="526" text-anchor="end"[^>]*>2026-03-06</u);
  });

  it('formats active-hours values as durations', () => {
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

    const svg = renderTrendsShareSvg(data, dark);

    expect(svg).toContain('Daily active hours');
    expect(svg).toContain('2h 19m');
  });

  it('renders a single incomplete cost day', () => {
    const data = createData();
    data.metric = 'cost';
    data.dateRange = { from: '2026-03-04', to: '2026-03-04' };
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

    const [svg] = renderInBothThemes((theme) => renderTrendsShareSvg(data, theme));

    expect(svg).toContain('Daily cost');
    expect(svg).toContain('1 day of all sources');
    expect(svg).toContain('~$12.34');
    expect(svg.match(/<rect data-date="/gu)).toHaveLength(1);
  });

  it('shows an empty state without days', () => {
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

    const [svg] = renderInBothThemes((theme) => renderTrendsShareSvg(data, theme));

    expect(svg).toContain('No usage in this window');
    expect(svg).not.toContain('data-date=');
  });
});
