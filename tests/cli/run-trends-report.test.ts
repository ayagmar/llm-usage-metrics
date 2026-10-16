import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../src/cli/build-share-report-data.js', () => ({
  buildShareReportData: vi.fn(),
}));

vi.mock('../../src/cli/share-artifact.js', () => ({
  writeShareFile: vi.fn(async (fileName: string) => `/tmp/${fileName}`),
  openShareFile: vi.fn(async () => {
    throw new Error('open disabled in tests');
  }),
}));

import { buildShareReportData } from '../../src/cli/build-share-report-data.js';
import { buildTrendsData } from '../../src/cli/build-trends-data.js';
import { buildTrendsReport, runTrendsReport } from '../../src/cli/run-trends-report.js';
import { writeShareFile } from '../../src/cli/share-artifact.js';
import { readFixturePayload } from '../share-report/client/core/share-fixture.js';

describe('run-trends-report', () => {
  beforeEach(() => {
    vi.mocked(buildShareReportData).mockResolvedValue(readFixturePayload().data);
  });

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

  it('renders markdown output and rejects combining it with --json', async () => {
    const report = await buildTrendsReport({
      markdown: true,
    });

    expect(report).toContain('| Date');
    expect(report).toContain('Total');

    await expect(
      buildTrendsReport({
        markdown: true,
        json: true,
      }),
    ).rejects.toThrow('Choose either --markdown or --json, not both');
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

  it('writes a share report while keeping the report body on stdout', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runTrendsReport({
        share: true,
      });

      const [request] = vi.mocked(buildShareReportData).mock.calls[0] ?? [];
      expect(request).toMatchObject({
        command: 'trends',
        window: { since: '2026-03-04', until: '2026-03-06' },
        initialView: { since: '2026-03-04', until: '2026-03-06', granularity: 'day' },
      });
      expect(request).not.toHaveProperty('envelope');

      expect(writeShareFile).toHaveBeenCalledTimes(1);
      const [fileName, page] = vi.mocked(writeShareFile).mock.calls[0] ?? [];
      expect(fileName).toBe('trends-share.html');
      expect(page).toContain('id="report-data"');

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(String(consoleLogSpy.mock.calls[0]?.[0])).toContain('Daily Token Usage Trend');
      expect(consoleErrorSpy.mock.calls.flat().join('\n')).toContain('Wrote trends share report');
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('accepts --by-source with --share: the page stacks by source', async () => {
    await buildTrendsReport({ bySource: true, share: true });

    expect(vi.mocked(buildShareReportData)).toHaveBeenCalledTimes(1);
  });

  it('delegates to buildTrendsData', async () => {
    await buildTrendsReport({ json: true });

    expect(vi.mocked(buildTrendsData)).toHaveBeenCalledWith({ json: true }, {});
  });
});
