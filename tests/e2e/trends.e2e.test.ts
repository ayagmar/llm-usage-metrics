import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildTrendsReport } from '../../src/cli/run-trends-report.js';

const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');

describe('trends report e2e', () => {
  it('renders deterministic token trends JSON for a selected date range', async () => {
    const report = await buildTrendsReport({
      piDir,
      codexDir,
      source: 'pi,codex',
      timezone: 'UTC',
      since: '2026-01-04',
      until: '2026-01-06',
      metric: 'tokens',
      json: true,
    });

    const parsed = JSON.parse(report) as {
      schemaVersion: number;
      report: string;
      data: {
        metric: string;
        totalSeries: { buckets: Array<{ date: string; observed: boolean }> };
      };
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'trends' });
    expect(parsed.data.metric).toBe('tokens');
    expect(parsed.data.totalSeries.buckets.map((bucket) => bucket.date)).toEqual([
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
    ]);
    expect(parsed.data.totalSeries.buckets.some((bucket) => bucket.observed)).toBe(true);
  });

  it('renders active-hours trends JSON with millisecond values', async () => {
    const report = await buildTrendsReport({
      piDir,
      codexDir,
      source: 'pi,codex',
      timezone: 'UTC',
      since: '2026-01-04',
      until: '2026-01-06',
      metric: 'active-hours',
      json: true,
    });

    const parsed = JSON.parse(report) as {
      data: {
        metric: string;
        totalSeries: { buckets: Array<{ date: string; value: number; observed: boolean }> };
      };
    };

    expect(parsed.data.metric).toBe('active-hours');
    expect(parsed.data.totalSeries.buckets.map((bucket) => bucket.date)).toEqual([
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
    ]);

    for (const bucket of parsed.data.totalSeries.buckets) {
      expect(Number.isInteger(bucket.value)).toBe(true);
      expect(bucket.value).toBeGreaterThanOrEqual(0);
    }
  });
});
