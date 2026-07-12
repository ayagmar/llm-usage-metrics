import { describe, expect, it } from 'vitest';

import { renderWrappedReport } from '../../src/render/render-wrapped-report.js';
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

describe('render-wrapped-report', () => {
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
    expect(output.includes('[')).toBe(false);
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
    expect(plain.includes('[')).toBe(false);
  });

  it('returns the recap as JSON for the json format', () => {
    const recap = createRecap();

    expect(JSON.parse(renderWrappedReport(recap, 'json'))).toEqual(recap);
  });
});
