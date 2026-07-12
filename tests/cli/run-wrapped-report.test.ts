import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as BuildWrappedDataModule from '../../src/cli/build-wrapped-data.js';

vi.mock('../../src/cli/build-wrapped-data.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BuildWrappedDataModule>();

  return {
    ...actual,
    buildWrappedData: vi.fn(async () => ({
      recap: {
        year: 2026,
        timezone: 'UTC',
        from: '2026-01-01',
        to: '2026-12-31',
        totalTokens: 1_000,
        costUsd: 12.34,
        costIncomplete: false,
        activeDays: 10,
        longestStreak: 3,
        activeMs: 2 * 60 * 60 * 1000,
        peakHour: { hour: 9, totalTokens: 500 },
        weekdayTokens: 800,
        weekendTokens: 200,
        busiestDay: { date: '2026-06-15', totalTokens: 400 },
        eventCount: 20,
        sessionCount: 5,
        topModels: [{ name: 'gpt-4.1', totalTokens: 600, costUsd: 8 }],
        topSources: [{ name: 'pi', totalTokens: 700, costUsd: 9 }],
        monthlyIntensity: Array.from({ length: 12 }, (_, index) => ({
          month: `2026-${String(index + 1).padStart(2, '0')}`,
          totalTokens: index * 10,
          level: index === 0 ? 0 : 1,
        })),
        dailyIntensity: Array.from({ length: 365 }, (_, index) => {
          const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
          return { date, totalTokens: index % 5, level: (index % 5) as 0 | 1 | 2 | 3 | 4 };
        }),
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
  };
});

vi.mock('../../src/cli/share-artifact.js', () => ({
  writeAndOpenShareSvgFile: vi.fn(async (fileName: string) => ({
    outputPath: `/tmp/${fileName}`,
    opened: false,
    openErrorMessage: 'open disabled in tests',
  })),
}));

import { buildWrappedData } from '../../src/cli/build-wrapped-data.js';
import { buildWrappedReport, runWrappedReport } from '../../src/cli/run-wrapped-report.js';
import { writeAndOpenShareSvgFile } from '../../src/cli/share-artifact.js';

describe('run-wrapped-report', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('builds JSON output without diagnostics in the body', async () => {
    const report = await buildWrappedReport({
      year: '2026',
      json: true,
    });

    const parsed = JSON.parse(report) as {
      schemaVersion: number;
      report: string;
      data: { year: number; diagnostics?: unknown };
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'wrapped' });
    expect(parsed.data.year).toBe(2026);
    expect(parsed.data).not.toHaveProperty('diagnostics');
  });

  it('renders terminal output by default', async () => {
    const report = await buildWrappedReport({
      year: '2026',
    });

    expect(report).toContain('Wrapped 2026');
    expect(report).toContain('Tokens');
    expect(report).toContain('1,000');
    expect(report).toContain('Top models');
    expect(report).toContain('gpt-4.1');
  });

  it('rejects invalid years before building data', async () => {
    const buildCallsBefore = vi.mocked(buildWrappedData).mock.calls.length;

    await expect(
      buildWrappedReport({
        year: '1999',
      }),
    ).rejects.toThrow('--year must be a four-digit year between 2020 and 2100');

    expect(vi.mocked(buildWrappedData).mock.calls).toHaveLength(buildCallsBefore);
  });

  it('rejects unsupported markdown output before building data', async () => {
    const buildCallsBefore = vi.mocked(buildWrappedData).mock.calls.length;

    await expect(
      buildWrappedReport({
        markdown: true,
      } as never),
    ).rejects.toThrow('--markdown is not supported for this command');

    expect(vi.mocked(buildWrappedData).mock.calls).toHaveLength(buildCallsBefore);
  });

  it('writes a wrapped share SVG while keeping the report body on stdout', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runWrappedReport({
        year: '2026',
        share: true,
      });

      expect(writeAndOpenShareSvgFile).toHaveBeenCalledTimes(1);
      const [fileName, svg] = vi.mocked(writeAndOpenShareSvgFile).mock.calls[0] ?? [];
      expect(fileName).toBe('llm-usage-wrapped-2026.svg');
      expect(svg).toContain('2026 Wrapped');

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(String(consoleLogSpy.mock.calls[0]?.[0])).toContain('Wrapped 2026');
      expect(consoleErrorSpy.mock.calls.flat().join('\n')).toContain('Wrote wrapped share SVG');
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('keeps diagnostics on stderr for JSON output', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runWrappedReport({
        year: '2026',
        json: true,
      });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0])) as {
        data: { year: number };
      };
      expect(parsed.data.year).toBe(2026);
      expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});
