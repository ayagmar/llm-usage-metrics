import { stripVTControlCharacters } from 'node:util';

import pc from 'picocolors';
import { describe, expect, it } from 'vitest';

import type { ToolsDataResult, ToolsReportRow } from '../../src/cli/build-tools-data.js';
import { renderToolsReport } from '../../src/render/render-tools-report.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';

const LONG_MCP_NAME = 'mcp__plugin_playwright_playwright__browser_navigate';

function toolRow(name: string, calls: number, extra: Partial<ToolsReportRow> = {}): ToolsReportRow {
  return {
    name,
    calls,
    errors: Math.round(calls / 50),
    unknown: 1,
    errorRate: 0.02,
    sessions: 40,
    topRepoRoot: null,
    topProject: 'projects/niri-computer-use',
    ...extra,
  };
}

function createToolsData(options: { bySource?: boolean } = {}): ToolsDataResult {
  const rows = options.bySource
    ? [toolRow('Bash', 64_494, { source: 'claude' }), toolRow('bash', 4_890, { source: 'pi' })]
    : [toolRow('Bash', 64_494), toolRow(LONG_MCP_NAME, 1_250), toolRow('Read', 6_183)];
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);

  return {
    data: {
      timezone: 'UTC',
      since: '2026-10-14',
      until: null,
      bySource: options.bySource ?? false,
      byRepo: false,
      rowCount: rows.length,
      rows,
      totals: { calls, errors: 1_400, unknown: 3, errorRate: 0.02, sessions: 900, tools: 3 },
    },
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

function render(terminalWidth: number, data = createToolsData()): string {
  return renderToolsReport(data, 'terminal', { useColor: false, terminalWidth });
}

function widestLine(output: string): number {
  return Math.max(...output.split('\n').map((line) => visibleWidth(line)));
}

function headerLine(output: string): string {
  return output.split('\n').find((line) => /^│ Tool +│/u.test(line)) ?? '';
}

describe('renderToolsReport terminal fit', () => {
  it('shows full counts and names when the table fits', () => {
    const output = render(200);

    expect(output).toContain('╭');
    expect(output).toContain('64,494');
    expect(output).toContain(LONG_MCP_NAME);
    expect(headerLine(output)).toContain('Unknown');
  });

  it('fits 120 columns by abbreviating counts and cutting a long name in the middle', () => {
    const output = render(120);

    expect(widestLine(output)).toBeLessThanOrEqual(120);
    expect(output).toContain('╭');
    expect(output).toContain('64.5K');
    // The start and the distinguishing end of the MCP name stay readable.
    const mcpLine = output.split('\n').find((line) => line.includes('mcp__plugin_')) ?? '';
    expect(mcpLine).toMatch(/…[^…]*navigate /u);
    expect(mcpLine).not.toContain(LONG_MCP_NAME);
    expect(headerLine(output)).toContain('Top Project');
  });

  it('fits 80 columns by hiding Unknown and Top Project before the counts', () => {
    const output = render(80);
    const header = headerLine(output);

    expect(widestLine(output)).toBeLessThanOrEqual(80);
    expect(output).toContain('╭');
    for (const kept of ['Tool', 'Calls', 'Errors', 'Error Rate', 'Sessions']) {
      expect(header).toContain(kept);
    }
    expect(header).not.toContain('Unknown');
    expect(header).not.toContain('Top Project');
  });

  it('lists rows in full detail at 44 columns', () => {
    const output = render(44);
    const valueLines = output.split('\n').filter((line) => line.startsWith('  '));

    // A listed row's title stays whole, so only its value lines must fit.
    expect(Math.max(...valueLines.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(44);
    expect(output).not.toContain('╭');
    expect(output).toContain(LONG_MCP_NAME);
    expect(output).toContain('64,494');
    expect(output).toContain('Top Project');
  });

  it('keeps the Source column when it hides columns for --by-source', () => {
    const output = render(80, createToolsData({ bySource: true }));

    expect(widestLine(output)).toBeLessThanOrEqual(80);
    expect(headerLine(output)).toContain('Source');
  });
});

describe('renderToolsReport colors', () => {
  // picocolors styles only where color is supported, as under CI.
  it.skipIf(!pc.isColorSupported)('colors cells without changing the layout', () => {
    const data = createToolsData({ bySource: true });

    for (const terminalWidth of [44, 80, 120]) {
      const colored = renderToolsReport(data, 'terminal', { useColor: true, terminalWidth });
      const plain = renderToolsReport(data, 'terminal', { useColor: false, terminalWidth });

      expect(colored).toContain('\u001b');
      expect(stripVTControlCharacters(colored)).toBe(plain);
      expect(plain).not.toContain('\u001b');
    }
  });
});
