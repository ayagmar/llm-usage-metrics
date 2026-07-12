import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cli/build-compare-data.js', () => ({
  buildCompareData: vi.fn(async () => ({
    current: {
      window: { since: '2026-06-01', until: '2026-06-30', label: '2026-06' },
      totals: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: 0.03,
        events: 1,
        activeDays: 1,
      },
    },
    baseline: {
      window: { since: '2026-05-01', until: '2026-05-31', label: '2026-05' },
      totals: {
        inputTokens: 5,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 10,
        costUsd: 0.02,
        events: 1,
        activeDays: 1,
      },
    },
    totals: [
      {
        key: 'totalTokens',
        label: 'Total tokens',
        valueType: 'integer',
        current: 15,
        baseline: 10,
        delta: 5,
        deltaRatio: 0.5,
      },
    ],
    sources: [],
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

import { buildCompareData } from '../../src/cli/build-compare-data.js';
import { buildCompareReport, runCompareReport } from '../../src/cli/run-compare-report.js';

describe('run-compare-report', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('builds JSON output from structured compare data', async () => {
    const report = await buildCompareReport({
      json: true,
    });
    const parsed = JSON.parse(report) as {
      schemaVersion: number;
      report: string;
      data: { current: { window: { label: string } } };
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'compare' });
    expect(parsed.data.current.window.label).toBe('2026-06');
  });

  it('renders markdown output when requested', async () => {
    const report = await buildCompareReport({
      markdown: true,
    });

    expect(report).toContain('### Compare: 2026-06 vs 2026-05');
    expect(report).toContain('| Metric');
  });

  it('rejects mutually exclusive output flags before building data', async () => {
    const buildCallsBefore = vi.mocked(buildCompareData).mock.calls.length;

    await expect(
      buildCompareReport({
        markdown: true,
        json: true,
      }),
    ).rejects.toThrow('Choose either --markdown or --json, not both');

    expect(vi.mocked(buildCompareData).mock.calls).toHaveLength(buildCallsBefore);
  });

  it('keeps diagnostics on stderr for JSON output', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runCompareReport({
        json: true,
      });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const stdoutBody = String(consoleLogSpy.mock.calls[0]?.[0]);
      const parsed = JSON.parse(stdoutBody) as {
        data: { current: { window: { label: string } } };
      };
      expect(parsed.data.current.window.label).toBe('2026-06');
      expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('delegates to buildCompareData', async () => {
    await buildCompareReport({ since: '2026-06-01', until: '2026-06-30', json: true });

    expect(vi.mocked(buildCompareData)).toHaveBeenCalledWith(
      { since: '2026-06-01', until: '2026-06-30', json: true },
      {},
    );
  });
});
