import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  renderWrappedReport,
  renderWrappedReportWithNotes,
} from '../../src/render/render-wrapped-report.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';
import type { WrappedRecap } from '../../src/wrapped/wrapped-recap.js';
import { markerPalette } from '../helpers/marker-palette.js';

function createRecap(overrides: Partial<WrappedRecap> = {}): WrappedRecap {
  return {
    year: 2026,
    timezone: 'UTC',
    from: '2026-01-01',
    to: '2026-12-31',
    totalTokens: 1_000,
    costUsd: 12.34,
    costIncomplete: false,
    activeDays: 10,
    activeMs: 3 * 60 * 60 * 1000,
    peakHour: { hour: 14, totalTokens: 400 },
    weekdayTokens: 700,
    weekendTokens: 300,
    busiestDay: { date: '2026-03-01', totalTokens: 400 },
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
    expect(output).toContain('Hours');
    expect(output).toContain('3h');
    expect(output).toContain('Peak hour');
    expect(output).toContain('14:00');
    expect(output).toContain('Weekdays        70% of tokens');
    expect(output).toContain('Busiest day');
    expect(output).toContain('2026-03-01 (400 tokens)');
    expect(output).toContain('Monthly activity');
    // Months on the sparkline's eighths of the busiest month; an idle month is a dot.
    expect(output).toContain('Jan ·');
    expect(output).toContain('Feb ▂');
    expect(output).toContain('Mar ▄');
    expect(output).toContain('Apr ▆');
    expect(output).toContain('May █');
    expect(output).toContain('Dec ▂');
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
    const colored = renderWrappedReport(createRecap({ estimatedCacheSavingsUsd: 5 }), 'terminal', {
      useColor: true,
      palette: markerPalette,
    });
    const plain = renderWrappedReport(createRecap(), 'terminal', {
      useColor: false,
      palette: markerPalette,
    });

    // Tokens keep the default color; cost is money, savings are good news.
    expect(colored).toMatch(/<dim>Tokens +<\/dim> {2}1,000$/mu);
    expect(colored).toContain('<yellow>$12.34</yellow>');
    expect(colored).toContain('<green>~$5.00</green>');
    expect(colored).toContain('<bold>Model</bold>');
    expect(colored).toContain('<yellow>$8.00</yellow>');
    expect(colored).toContain('<green>█</green>');
    expect(plain).not.toContain('<bold>');
    expect(plain).not.toContain('<cyan>');
    expect(plain).not.toContain('<green>');
    expect(plain.includes('[')).toBe(false);
  });

  it('abbreviates the busiest day like the summary does', () => {
    const output = renderWrappedReport(
      createRecap({ busiestDay: { date: '2026-10-14', totalTokens: 3_296_247_858 } }),
      'terminal',
      { useColor: false },
    );

    expect(output).toContain('2026-10-14 (3.3B tokens)');
  });

  it('fits the monthly strip and top tables to 44, 80, and 120 columns', () => {
    const recap = createRecap({
      timezone: 'America/Argentina/Buenos_Aires',
      topModels: [
        { name: 'claude-opus-5-5', totalTokens: 24_664_225_687, costUsd: 9_397.54 },
        { name: 'claude-fable-5-1', totalTokens: 1_599_077_630, costUsd: 2_065.42 },
      ],
    });
    const render = (terminalWidth: number) =>
      renderWrappedReport(recap, 'terminal', { useColor: true, terminalWidth }).split('\n');
    const plainLines = (terminalWidth: number) =>
      render(terminalWidth).map((line) => stripVTControlCharacters(line));

    for (const terminalWidth of [44, 80, 120]) {
      for (const line of render(terminalWidth)) {
        expect(visibleWidth(line), `${String(terminalWidth)}: ${line}`).toBeLessThanOrEqual(
          terminalWidth,
        );
      }
    }

    const stripRows = (lines: string[]) =>
      lines.filter((line) => /^[A-Z][a-z]{2} \S {2}/u.test(line));
    expect(stripRows(plainLines(120))).toHaveLength(1);
    expect(stripRows(plainLines(80))).toEqual([
      expect.stringMatching(/^Jan .* Jun \S+$/u),
      expect.stringMatching(/^Jul .* Dec \S+$/u),
    ]);
    // A table, not a list: tokens abbreviated before the rank column goes.
    expect(plainLines(80).join('\n')).toContain('24,664,225,687');
    expect(plainLines(44).join('\n')).toMatch(/│ claude-opus-5-5 +│ +24\.7B │ \$9,397\.54 │/u);
  });

  it('renders markdown stat and top tables', () => {
    const output = renderWrappedReport(createRecap(), 'markdown');

    expect(output).toContain('### Wrapped 2026');
    expect(output).toContain('2026-01-01 to 2026-12-31 (UTC)');
    expect(output).toContain('| Stat');
    expect(output).toContain('| Tokens');
    expect(output).toContain('1,000');
    expect(output).toContain('$12.34');
    expect(output).toContain('| Hours');
    expect(output).toContain('3h');
    expect(output).toContain('14:00');
    expect(output).toMatch(/\| Weekdays\s+\|\s+70% of tokens \|/u);
    expect(output).toContain('### Top models');
    expect(output).toContain('gpt-4.1');
    expect(output).toContain('### Top sources');
    expect(output).toContain('pi');
  });

  it('prints one message for an empty year in the terminal and keeps dashed markdown tables', () => {
    const recap = createRecap({
      totalTokens: 0,
      costUsd: undefined,
      activeDays: 0,
      longestStreak: 0,
      activeMs: 0,
      peakHour: undefined,
      weekdayTokens: 0,
      weekendTokens: 0,
      busiestDay: undefined,
      estimatedCacheSavingsUsd: undefined,
      eventCount: 0,
      sessionCount: 0,
      topModels: [],
      topSources: [],
    });

    const output = renderWrappedReport(recap, 'terminal', { useColor: false });

    expect(output).toContain(`No usage data found in ${recap.year}.`);
    expect(output).not.toContain('Top models');
    expect(output).not.toContain('Cost');

    expect(renderWrappedReport(recap, 'terminal', { useColor: false, filtered: true })).toContain(
      `No usage data found in ${recap.year} for the selected filters.`,
    );

    const markdown = renderWrappedReport(recap, 'markdown');
    expect(markdown).toContain('0h');
    expect(markdown).toMatch(/\| Peak hour\s+\|\s+- \|/);
    expect(markdown).toMatch(/\| Weekdays\s+\|\s+- \|/);
    expect(markdown).toMatch(/\| Busiest day\s+\|\s+- \|/);
    expect(markdown).toMatch(/\| Cache savings\s+\|\s+- \|/);
  });

  it('returns the recap as JSON for the json format', () => {
    const recap = createRecap();

    expect(JSON.parse(renderWrappedReport(recap, 'json'))).toEqual({
      schemaVersion: 1,
      report: 'wrapped',
      data: recap,
    });
  });
});

describe('renderWrappedReportWithNotes', () => {
  const recap = createRecap({
    topModels: [
      { name: 'claude-opus-5-5', totalTokens: 24_664_225_687, costUsd: 9_397.54 },
      { name: 'claude-fable-5-1', totalTokens: 1_599_077_630, costUsd: 2_065.42 },
    ],
    topSources: [{ name: 'claude-code-desktop', totalTokens: 24_664_225_687, costUsd: 9_397.54 }],
  });
  const notesAt = (terminalWidth: number) =>
    renderWrappedReportWithNotes(recap, 'terminal', { useColor: false, terminalWidth });

  it.each([44])('gives one note for the top tables at %i columns, outside stdout', (width) => {
    const { output, notes } = notesAt(width);

    expect(notes).toEqual([
      'Fitted the tables to the terminal: abbreviated token counts, hid Rank. Widen the terminal or use --json for full detail.',
    ]);
    expect(output).not.toMatch(/\bRank\b/u);
    // The rank column (`#`) is gone from both top tables.
    expect(output.split('\n').filter((line) => line.startsWith('│ #'))).toEqual([]);
    expect(renderWrappedReportWithNotes(recap, 'terminal', { terminalWidth: 400 }).output).toMatch(
      /^│ # /mu,
    );
    expect(output).not.toContain(notes[0]);
  });

  it('has no note when the tables fit, or for markdown and json', () => {
    expect(notesAt(400).notes).toEqual([]);

    for (const format of ['markdown', 'json'] as const) {
      expect(renderWrappedReportWithNotes(recap, format, { terminalWidth: 44 }).notes).toEqual([]);
    }
  });
});
