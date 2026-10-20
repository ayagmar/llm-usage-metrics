import { stripVTControlCharacters } from 'node:util';

import pc from 'picocolors';
import { describe, expect, it } from 'vitest';

import type { ToolsDataResult, ToolsReportRow } from '../../src/cli/build-tools-data.js';
import {
  renderToolsReport,
  renderToolsReportWithNotes,
} from '../../src/render/render-tools-report.js';
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
    const lines = output.split('\n');
    const titleStart = lines.findIndex((line) => line.startsWith('mcp__'));
    const titleLines = lines.slice(titleStart, titleStart + 2);

    expect(widestLine(output)).toBeLessThanOrEqual(44);
    expect(output).not.toContain('╭');
    // A title wider than the terminal wraps between the name's parts, losing no character.
    expect(titleLines.join('')).toBe(LONG_MCP_NAME);
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

describe('renderToolsReportWithNotes', () => {
  const notesAt = (terminalWidth: number) =>
    renderToolsReportWithNotes(createToolsData(), 'terminal', { useColor: false, terminalWidth });

  it.each([
    [
      120,
      'Fitted the table to the terminal: abbreviated counts, shortened long names. Widen the terminal or use --json for full detail.',
    ],
    [
      80,
      'Fitted the table to the terminal: abbreviated counts, hid Unknown and Top Project, shortened long names. Widen the terminal or use --json for full detail.',
    ],
    [
      44,
      'Listed rows instead of a table to fit the terminal. Widen the terminal to see the table.',
    ],
  ])('says what %i columns changed, outside stdout', (width, note) => {
    const { output, notes } = notesAt(width);

    expect(notes).toEqual([note]);
    expect(note).not.toContain('token');
    expect(output).not.toContain(note);
  });

  it.each([
    {
      changed: 'counts only',
      data: createToolsData({ bySource: true }),
      says: 'abbreviated counts',
      not: 'shortened',
    },
    {
      changed: 'names only',
      data: (() => {
        const data = createToolsData();
        const rows = [toolRow('Bash', 64), toolRow(LONG_MCP_NAME, 12)];
        return {
          ...data,
          data: {
            ...data.data,
            rowCount: rows.length,
            rows,
            totals: { calls: 76, errors: 1, unknown: 2, errorRate: 0.02, sessions: 80, tools: 2 },
          },
        };
      })(),
      says: 'shortened long names',
      not: 'abbreviated',
    },
  ])('names only what the fitted step changed ($changed)', ({ data, says, not }) => {
    const [note] = renderToolsReportWithNotes(data, 'terminal', {
      useColor: false,
      terminalWidth: 80,
    }).notes;

    expect(note).toContain(says);
    expect(note).not.toContain(not);
  });

  it('names columns that are really missing from the header at 80 columns', () => {
    const header = headerLine(notesAt(80).output);

    expect(header).not.toContain('Unknown');
    expect(header).not.toContain('Top Project');
  });

  it('has no note when the table fits, or for markdown and json', () => {
    expect(notesAt(400).notes).toEqual([]);

    for (const format of ['markdown', 'json'] as const) {
      expect(
        renderToolsReportWithNotes(createToolsData(), format, { terminalWidth: 44 }).notes,
      ).toEqual([]);
    }
  });
});
