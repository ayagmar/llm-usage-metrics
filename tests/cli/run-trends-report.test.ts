import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cli/build-trends-data.js', () => ({
  buildTrendsData: vi.fn(async () => ({
    metric: 'tokens',
    dateRange: { from: '2026-03-04', to: '2026-03-06' },
    totalSeries: {
      source: 'combined',
      buckets: [
        { date: '2026-03-04', value: 10, observed: true },
        { date: '2026-03-05', value: 0, observed: false },
      ],
      summary: {
        total: 10,
        average: 5,
        peak: { date: '2026-03-04', value: 10 },
        incomplete: false,
        observedDayCount: 1,
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
  })),
}));

import { buildTrendsData } from '../../src/cli/build-trends-data.js';
import { buildTrendsReport, runTrendsReport } from '../../src/cli/run-trends-report.js';

describe('run-trends-report', () => {
  it('builds JSON output without diagnostics in the body', async () => {
    const report = await buildTrendsReport({
      json: true,
    });

    const parsed = JSON.parse(report) as Record<string, unknown>;

    expect(parsed.metric).toBe('tokens');
    expect(parsed).not.toHaveProperty('diagnostics');
  });

  it('rejects unsupported markdown output', async () => {
    const buildCallsBefore = vi.mocked(buildTrendsData).mock.calls.length;

    await expect(
      buildTrendsReport({
        markdown: true,
      } as never),
    ).rejects.toThrow('--markdown is not supported for this command');

    expect(vi.mocked(buildTrendsData).mock.calls).toHaveLength(buildCallsBefore);
  });

  it('keeps diagnostics on stderr for JSON output', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runTrendsReport({
      json: true,
    });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const stdoutBody = String(consoleLogSpy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(stdoutBody) as Record<string, unknown>;
    expect(parsed.metric).toBe('tokens');

    expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('delegates to buildTrendsData', async () => {
    await buildTrendsReport({ json: true });

    expect(vi.mocked(buildTrendsData)).toHaveBeenCalledWith({ json: true });
  });
});
