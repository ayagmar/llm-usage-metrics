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
        totalCostUsd: 12.34,
        costIncomplete: false,
        activeDays: 10,
        longestStreak: 3,
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
import {
  buildWrappedReport,
  renderWrappedReport,
  runWrappedReport,
} from '../../src/cli/run-wrapped-report.js';
import { writeAndOpenShareSvgFile } from '../../src/cli/share-artifact.js';
import type { TerminalStylePalette } from '../../src/render/terminal-style-policy.js';
import type { WrappedRecap } from '../../src/wrapped/wrapped-recap.js';

function createRecap(overrides: Partial<WrappedRecap> = {}): WrappedRecap {
  return {
    year: 2026,
    timezone: 'UTC',
    from: '2026-01-01',
    to: '2026-12-31',
    totalTokens: 1_000,
    totalCostUsd: 12.34,
    costIncomplete: false,
    activeDays: 10,
    longestStreak: 3,
    eventCount: 20,
    sessionCount: 5,
    topModels: [
      { name: 'gpt-4.1', totalTokens: 600, costUsd: 8 },
      { name: 'claude-4', totalTokens: 300, costUsd: 4 },
    ],
    topSources: [{ name: 'pi', totalTokens: 700, costUsd: 9 }],
    monthlyIntensity: [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1].map((level, index) => ({
      month: `2026-${String(index + 1).padStart(2, '0')}`,
      totalTokens: level * 100,
      level: level as 0 | 1 | 2 | 3 | 4,
    })),
    dailyIntensity: Array.from({ length: 365 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
      return { date, totalTokens: index % 5, level: (index % 5) as 0 | 1 | 2 | 3 | 4 };
    }),
    ...overrides,
  };
}

// Sentinel-wrapping palette so color application is deterministic regardless of TTY detection.
const markerPalette: TerminalStylePalette = {
  cyan: (text) => `<cyan>${text}</cyan>`,
  magenta: (text) => `<magenta>${text}</magenta>`,
  blue: (text) => `<blue>${text}</blue>`,
  yellow: (text) => `<yellow>${text}</yellow>`,
  green: (text) => `<green>${text}</green>`,
  white: (text) => `<white>${text}</white>`,
  bold: (text) => `<bold>${text}</bold>`,
  dim: (text) => `<dim>${text}</dim>`,
};

describe('run-wrapped-report', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('builds JSON output without diagnostics in the body', async () => {
    const report = await buildWrappedReport({
      year: '2026',
      json: true,
    });

    const parsed = JSON.parse(report) as { year: number; diagnostics?: unknown };

    expect(parsed.year).toBe(2026);
    expect(parsed).not.toHaveProperty('diagnostics');
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
      const parsed = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0])) as { year: number };
      expect(parsed.year).toBe(2026);
      expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});

describe('renderWrappedReport terminal rendering', () => {
  it('renders a boxed header, aligned stats, monthly strip, and top tables without color', () => {
    const output = renderWrappedReport(createRecap(), 'terminal', { useColor: false });

    expect(output).toContain('┌');
    expect(output).toContain('│ Wrapped 2026 │');
    expect(output).toContain('2026-01-01 to 2026-12-31 (UTC)');
    expect(output).toContain('Tokens');
    expect(output).toContain('1,000');
    expect(output).toContain('Cost');
    expect(output).toContain('$12.34');
    expect(output).toContain('Longest streak');
    expect(output).toContain('3 days');
    expect(output).toContain('Monthly activity');
    expect(output).toContain('Jan ·');
    expect(output).toContain('Feb ▁');
    expect(output).toContain('Mar ▂');
    expect(output).toContain('Apr ▄');
    expect(output).toContain('May █');
    expect(output).toContain('Dec ▁');
    expect(output).toContain('Top models');
    expect(output).toContain('Model');
    expect(output).toContain('gpt-4.1');
    expect(output).toContain('Top sources');
    expect(output).toContain('Source');
    expect(output).toContain('pi');
    expect(output.includes('[')).toBe(false);
  });

  it('uses a singular day label for a one-day streak', () => {
    const output = renderWrappedReport(createRecap({ longestStreak: 1 }), 'terminal', {
      useColor: false,
    });

    expect(output).toContain('1 day');
    expect(output).not.toContain('1 days');
  });

  it('renders a placeholder row when a top list is empty', () => {
    const output = renderWrappedReport(createRecap({ topModels: [] }), 'terminal', {
      useColor: false,
    });

    expect(output).toContain('Top models');
    expect(output).toMatch(/│ - +│/);
  });

  it('styles stats and the monthly strip only when color is enabled', () => {
    const colored = renderWrappedReport(createRecap(), 'terminal', {
      useColor: true,
      palette: markerPalette,
    });
    const plain = renderWrappedReport(createRecap(), 'terminal', {
      useColor: false,
      palette: markerPalette,
    });

    expect(colored).toContain('<bold><cyan>1,000</cyan></bold>');
    expect(colored).toContain('<green>█</green>');
    expect(plain).not.toContain('<bold>');
    expect(plain).not.toContain('<cyan>');
    expect(plain).not.toContain('<green>');
    expect(plain.includes('[')).toBe(false);
  });
});
