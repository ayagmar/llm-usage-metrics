import pc from 'picocolors';
import { describe, expect, it } from 'vitest';

import type { CompareProjectRow, CompareReportData } from '../../src/cli/build-compare-data.js';
import { renderCompareReport } from '../../src/render/render-compare-report.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';
import type {
  CompareDataResult,
  CompareMetricKey,
  CompareMetricRow,
} from '../../src/cli/usage-data-contracts.js';

function createCompareData(): CompareDataResult {
  return {
    current: {
      window: { since: '2026-06-01', until: '2026-06-30', label: '2026-06' },
      totals: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        totalTokens: 180,
        costUsd: 3,
        costIncomplete: true,
        events: 2,
        activeDays: 2,
      },
    },
    baseline: {
      window: { since: '2026-05-01', until: '2026-05-31', label: '2026-05' },
      totals: {
        inputTokens: 80,
        outputTokens: 40,
        reasoningTokens: 0,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        totalTokens: 130,
        costUsd: 2,
        events: 1,
        activeDays: 1,
      },
    },
    totals: [
      {
        key: 'inputTokens',
        label: 'Input',
        valueType: 'integer',
        current: 100,
        baseline: 80,
        delta: 20,
        deltaRatio: 0.25,
      },
      {
        key: 'costUsd',
        label: 'Cost',
        valueType: 'usd',
        current: 3,
        baseline: 2,
        delta: 1,
        deltaRatio: 0.5,
        currentCostIncomplete: true,
        deltaCostIncomplete: true,
      },
      {
        key: 'reasoningTokens',
        label: 'Reasoning',
        valueType: 'integer',
        current: 0,
        baseline: 0,
        delta: 0,
        deltaRatio: 0,
      },
    ],
    sources: [
      {
        source: 'co|dex',
        current: {
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          totalTokens: 180,
          costUsd: 3,
          costIncomplete: true,
          events: 2,
          activeDays: 2,
        },
        baseline: {
          inputTokens: 80,
          outputTokens: 40,
          reasoningTokens: 0,
          cacheReadTokens: 10,
          cacheWriteTokens: 0,
          totalTokens: 130,
          costUsd: 2,
          events: 1,
          activeDays: 1,
        },
        delta: {
          inputTokens: 20,
          outputTokens: 10,
          reasoningTokens: 0,
          cacheReadTokens: 10,
          cacheWriteTokens: 10,
          totalTokens: 50,
          costUsd: 1,
          costIncomplete: true,
          events: 1,
          activeDays: 1,
        },
        deltaRatio: {
          costUsd: 0.5,
        },
      },
    ],
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

function metricRow(
  key: CompareMetricKey,
  label: string,
  current: number,
  baseline: number,
): CompareMetricRow {
  return {
    key,
    label,
    valueType: key === 'costUsd' ? 'usd' : 'integer',
    current,
    baseline,
    delta: current - baseline,
    deltaRatio: (current - baseline) / baseline,
  };
}

const longProjectName = 'clients/acme-corporation/monorepo/services/billing-api';

function projectRow(project: string, current: number, baseline: number): CompareProjectRow {
  const [source] = createCompareData().sources;

  return {
    ...source,
    repoRoot: `/home/user/${project}`,
    project,
    current: { ...source.current, costUsd: current, costIncomplete: undefined },
    baseline: { ...source.baseline, costUsd: baseline },
    delta: { ...source.delta, costUsd: current - baseline, costIncomplete: undefined },
    deltaRatio: { costUsd: (current - baseline) / baseline },
  };
}

/** A month of heavy use: totals in the billions, as `compare --by-repo` prints them. */
function createLargeCompareData(): CompareReportData {
  return {
    ...createCompareData(),
    totals: [
      metricRow('inputTokens', 'Input', 45_583_191, 18_363_811),
      metricRow('outputTokens', 'Output', 105_935_777, 7_382_845),
      metricRow('reasoningTokens', 'Reasoning', 39_450_448, 3_036_409),
      metricRow('cacheReadTokens', 'Cache Read', 25_555_431_845, 1_729_231_876),
      metricRow('cacheWriteTokens', 'Cache Write', 402_955_933, 36_720_718),
      metricRow('totalTokens', 'Total Tokens', 26_109_906_746, 1_791_699_250),
      metricRow('costUsd', 'Cost', 10_543.08, 1_216.44),
      metricRow('events', 'Events', 154_460, 14_208),
      metricRow('activeDays', 'Active Days', 20, 17),
    ],
    projects: [projectRow(longProjectName, 1_098.2, 12.5), projectRow('wagr', 0.5, 256.43)],
  };
}

/** The lines of the boxed table that follows `caption`, top border to bottom border. */
function boxedTableAfter(output: string, caption: string): string[] {
  const lines = output.split('\n');
  const start = lines.indexOf(caption) + 1;
  const end = lines.findIndex((line, index) => index >= start && line.startsWith('╰'));

  return lines.slice(start, end + 1);
}

describe('renderCompareReport', () => {
  it('renders terminal output without color', () => {
    const output = renderCompareReport(createCompareData(), 'terminal', { useColor: false });

    expect(output).toContain('Compare: 2026-06 vs 2026-05');
    expect(output).toContain('Metric');
    expect(output).toContain('Input');
    expect(output).toContain('+20');
    expect(output).toContain('~$3.00');
    expect(output).toContain('+~$1.00');
    expect(output).toContain('By source (cost)');
    expect(output).toContain('co|dex');
  });

  it('prints one message instead of zeroed tables when both windows are empty', () => {
    const data = createCompareData();
    const zeroedData: CompareDataResult = {
      ...data,
      current: {
        ...data.current,
        totals: { ...data.current.totals, events: 0 },
      },
      baseline: {
        ...data.baseline,
        totals: { ...data.baseline.totals, events: 0 },
      },
    };

    const output = renderCompareReport(zeroedData, 'terminal', { useColor: false });
    const filteredOutput = renderCompareReport(zeroedData, 'terminal', {
      useColor: false,
      filtered: true,
    });

    expect(output).toContain('No usage data found.');
    expect(output).not.toContain('Metric');
    expect(output).not.toContain('By source');
    expect(filteredOutput).toContain('No usage data found for the selected filters.');
  });

  it('renders markdown output with escaped table cells', () => {
    const output = renderCompareReport(createCompareData(), 'markdown');

    expect(output).toContain('### Compare: 2026-06 vs 2026-05');
    expect(output).toContain('| Metric');
    expect(output).toContain('+\\~$1.00');
    expect(output).toContain('co\\|dex');
  });

  it('renders structured JSON output', () => {
    const output = renderCompareReport(createCompareData(), 'json');
    const parsed = JSON.parse(output) as {
      schemaVersion: number;
      report: string;
      data: CompareDataResult;
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'compare' });
    expect(parsed.data.current.window).toEqual({
      since: '2026-06-01',
      until: '2026-06-30',
      label: '2026-06',
    });
    expect(parsed.data.totals[0]).toMatchObject({ key: 'inputTokens', delta: 20 });
    expect(parsed.data.sources[0]).toMatchObject({ source: 'co|dex' });
  });

  it('excludes diagnostics from JSON output', () => {
    const output = renderCompareReport(createCompareData(), 'json');

    expect(output).not.toContain('"diagnostics"');
    expect(output).not.toContain('"runtimeProfile"');
    expect(output).not.toContain('"activeConfig"');
    expect(output).not.toContain('"activeEnvOverrides"');
  });

  it('shortens long project names so the project table keeps its box', () => {
    const output = renderCompareReport(createLargeCompareData(), 'terminal', {
      useColor: false,
      terminalWidth: 120,
    });
    const table = boxedTableAfter(output, 'By project (cost)');
    const nameRow = table.find((line) => line.includes('clients/'));

    expect(table[0].startsWith('╭')).toBe(true);
    expect(new Set(table.map(visibleWidth)).size).toBe(1);
    expect(nameRow).toContain('│ clients/acme-c…s/billing-api │');
    expect(renderCompareReport(createLargeCompareData(), 'markdown')).toContain(longProjectName);
    expect(renderCompareReport(createLargeCompareData(), 'json')).toContain(longProjectName);
  });

  it('keeps the totals a table with full counts at 80 columns', () => {
    const output = renderCompareReport(createLargeCompareData(), 'terminal', {
      useColor: false,
      terminalWidth: 80,
    });

    expect(output).toContain('│ Cache Read   │ 25,555,431,845 │ 1,729,231,876 │');
    expect(output).not.toContain('\nCache Read\n');
  });

  it('abbreviates tokens, then hides Baseline and Δ%, before listing rows at 44 columns', () => {
    const output = renderCompareReport(createLargeCompareData(), 'terminal', {
      useColor: false,
      terminalWidth: 44,
    });
    const totals = boxedTableAfter(output, '');

    expect(totals[1]).toMatch(/^│ Metric +│ +Current │ +Δ │$/u);
    expect(output).toContain('│ Cache Read   │      25.6B │     +23.8B │');
    // Events and days are counts, not tokens: they stay whole.
    expect(output).toContain('│ Events       │    154,460 │   +140,252 │');
    expect(output).toContain('│ Cost         │ $10,543.08 │ +$9,326.64 │');
  });

  it.each([44, 80, 120])('fits every line in %i columns, with and without color', (width) => {
    const data = createLargeCompareData();
    // A custom range is named in full, so the title is wider than 44 columns.
    const customRange: CompareReportData = {
      ...data,
      current: {
        ...data.current,
        window: { ...data.current.window, label: '2026-06-03 to 2026-06-20' },
      },
      baseline: {
        ...data.baseline,
        window: { ...data.baseline.window, label: '2026-05-03 to 2026-05-20' },
      },
    };

    for (const useColor of [false, true]) {
      const output = renderCompareReport(customRange, 'terminal', {
        useColor,
        terminalWidth: width,
      });

      for (const line of output.split('\n')) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  // picocolors emits nothing without a color terminal, so this runs where color is on (CI).
  it.runIf(pc.isColorSupported)('colors a cost increase red and a decrease green', () => {
    const output = renderCompareReport(createLargeCompareData(), 'terminal', {
      useColor: true,
      terminalWidth: 120,
    });

    expect(output).toContain(pc.red('+$9,326.64'));
    expect(output).toContain(pc.green('-$255.93'));
    expect(output).toContain(pc.green('-99.8%'));
    expect(output).toContain(pc.yellow('$10,543.08'));
    // A token change has no good or bad direction.
    expect(output).toContain('│     +27,219,380 │');
  });
});
