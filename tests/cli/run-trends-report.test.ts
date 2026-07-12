import { afterEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../src/cli/share-artifact.js', () => ({
  writeAndOpenShareSvgFile: vi.fn(async (fileName: string) => ({
    outputPath: `/tmp/${fileName}`,
    opened: false,
    openErrorMessage: 'open disabled in tests',
  })),
}));

import { buildTrendsData } from '../../src/cli/build-trends-data.js';
import { buildTrendsReport, runTrendsReport } from '../../src/cli/run-trends-report.js';
import { writeAndOpenShareSvgFile } from '../../src/cli/share-artifact.js';

describe('run-trends-report', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('builds JSON output without diagnostics in the body', async () => {
    const report = await buildTrendsReport({
      json: true,
    });

    const parsed = JSON.parse(report) as {
      schemaVersion: number;
      report: string;
      data: Record<string, unknown>;
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'trends' });
    expect(parsed.data.metric).toBe('tokens');
    expect(parsed.data).not.toHaveProperty('diagnostics');
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

    try {
      await runTrendsReport({
        json: true,
      });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const stdoutBody = String(consoleLogSpy.mock.calls[0]?.[0]);
      const parsed = JSON.parse(stdoutBody) as { data: Record<string, unknown> };
      expect(parsed.data.metric).toBe('tokens');

      expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('writes a share SVG while keeping the report body on stdout', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runTrendsReport({
        share: true,
      });

      expect(writeAndOpenShareSvgFile).toHaveBeenCalledTimes(1);
      const [fileName, svg] = vi.mocked(writeAndOpenShareSvgFile).mock.calls[0] ?? [];
      expect(fileName).toBe('trends-share.svg');
      expect(svg).toContain('Daily Token Usage Trend');

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(String(consoleLogSpy.mock.calls[0]?.[0])).toContain('Daily Token Usage Trend');
      expect(consoleErrorSpy.mock.calls.flat().join('\n')).toContain('Wrote trends share SVG');
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('rejects by-source share before building trend data', async () => {
    const buildCallsBefore = vi.mocked(buildTrendsData).mock.calls.length;

    await expect(
      buildTrendsReport({
        bySource: true,
        share: true,
      }),
    ).rejects.toThrow('--share does not support --by-source yet; run without --by-source');

    expect(vi.mocked(buildTrendsData).mock.calls).toHaveLength(buildCallsBefore);
  });

  it('delegates to buildTrendsData', async () => {
    await buildTrendsReport({ json: true });

    expect(vi.mocked(buildTrendsData)).toHaveBeenCalledWith({ json: true }, {});
  });
});
