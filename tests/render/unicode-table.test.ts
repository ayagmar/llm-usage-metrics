import { describe, expect, it } from 'vitest';

import { visibleWidth, wrapTableColumn } from '../../src/render/table-text-layout.js';
import {
  renderUnicodeTable,
  renderUnicodeTableWithFit,
  type TableRowMeta,
} from '../../src/render/unicode-table.js';

function createRowMeta(overrides: Partial<TableRowMeta> = {}): TableRowMeta {
  return {
    periodKey: '2026-02-22',
    periodGroup: 'normal',
    rowKind: 'detail',
    ...overrides,
  };
}

describe('renderUnicodeTable', () => {
  it('wraps a listed value between name parts when it is longer than the line', () => {
    const model = 'deepseek/deepseek-v4.1-flash';
    const rendered = renderUnicodeTable({
      headerCells: ['Session', 'Model'],
      bodyRows: [['…3b0277334e93', model]],
      measureHeaderCells: ['Session', 'Model'],
      measureBodyRows: [['…3b0277334e93', model]],
      rowMetas: [createRowMeta()],
      columnKinds: ['text', 'text'],
      multilineColumnIndex: 1,
      terminalWidth: 30,
      stackedTitleColumnCount: 1,
    });

    expect(rendered.split('\n')).toEqual([
      '…3b0277334e93',
      '  Model  deepseek/deepseek-',
      '         v4.1-flash',
    ]);
  });

  it('drops the alignment padding of lines too long for a listed value, wrapping only the longest', () => {
    const cell = ['• a-very-long-project-name  $1.00', '• api                      $2.00'].join(
      '\n',
    );
    const rendered = renderUnicodeTable({
      headerCells: ['Month', 'Projects'],
      bodyRows: [['2026-06', cell]],
      measureHeaderCells: ['Month', 'Projects'],
      measureBodyRows: [['2026-06', cell]],
      rowMetas: [createRowMeta()],
      columnKinds: ['text', 'text'],
      multilineColumnIndex: 1,
      terminalWidth: 36,
      stackedTitleColumnCount: 1,
    });

    expect(rendered.split('\n')).toEqual([
      '2026-06',
      '  Projects  • a-very-long-project-',
      '            name $1.00',
      '            • api $2.00',
    ]);
  });

  it('lists rows as labelled values when the table is wider than the terminal', () => {
    const rendered = renderUnicodeTable({
      headerCells: ['Session', 'Source', 'Cost', 'Models'],
      bodyRows: [['…3b0277334e93', 'codex', '', 'gpt-5.4\nclaude-opus-4-8']],
      measureHeaderCells: ['Session', 'Source', 'Cost', 'Models'],
      measureBodyRows: [['…3b0277334e93', 'codex', '', 'gpt-5.4\nclaude-opus-4-8']],
      rowMetas: [createRowMeta()],
      columnKinds: ['text', 'text', 'measure', 'text'],
      multilineColumnIndex: 3,
      terminalWidth: 30,
      stackedTitleColumnCount: 1,
    });

    expect(rendered.split('\n')).toEqual([
      '…3b0277334e93',
      '  Source  codex',
      '  Models  gpt-5.4',
      '          claude-opus-4-8',
    ]);
  });

  it('pads missing body/measure rows when usage row counts are misaligned', () => {
    const rendered = renderUnicodeTable({
      headerCells: ['Period', 'Source'],
      bodyRows: [],
      measureHeaderCells: ['Period', 'Source'],
      measureBodyRows: [],
      rowMetas: [createRowMeta()],
      columnKinds: ['text', 'text'],
      multilineColumnIndex: 1,
      multilineColumnWidth: 12,
    });

    expect(rendered).toContain('╭');
    expect(rendered).toContain('╰');
  });

  it('pads short body rows so splitCellLines always receives strings', () => {
    const rendered = renderUnicodeTable({
      headerCells: ['Period', 'Source'],
      bodyRows: [['2026-02-22']],
      measureHeaderCells: ['Period', 'Source'],
      measureBodyRows: [['2026-02-22']],
      rowMetas: [createRowMeta()],
      columnKinds: ['text', 'text'],
      multilineColumnIndex: 1,
      multilineColumnWidth: 12,
    });

    expect(rendered).toContain('2026-02-22');
  });

  it('uses max column count across rows to keep later wider rows aligned', () => {
    const rendered = renderUnicodeTable({
      headerCells: ['Period', 'Source'],
      bodyRows: [
        ['2026-02-22', 'pi'],
        ['2026-02-22', 'opencode', 'extra-cell'],
      ],
      measureHeaderCells: ['Period', 'Source'],
      measureBodyRows: [
        ['2026-02-22', 'pi'],
        ['2026-02-22', 'opencode', 'extra-cell'],
      ],
      rowMetas: [createRowMeta(), createRowMeta()],
      columnKinds: ['text', 'text'],
      multilineColumnIndex: 1,
      multilineColumnWidth: 12,
    });

    expect(rendered).toContain('extra-cell');
  });

  it('uses a shared column count when body has more columns than measure rows', () => {
    const rendered = renderUnicodeTable({
      headerCells: ['Period', 'Source'],
      bodyRows: [['2026-02-22', 'opencode', 'extra']],
      measureHeaderCells: ['Period', 'Source'],
      measureBodyRows: [['2026-02-22', 'opencode']],
      rowMetas: [createRowMeta()],
      columnKinds: ['text', 'text'],
      multilineColumnIndex: 1,
      multilineColumnWidth: 12,
    });
    const topBorder = rendered.split('\n')[0] ?? '';

    expect((topBorder.match(/┬/g) ?? []).length).toBe(2);
    expect(rendered).not.toContain('undefined');
  });

  it('aligns columns by kind, not by their position after the multiline column', () => {
    const rendered = renderUnicodeTable({
      headerCells: ['Session', 'Total', 'Models', 'Newest'],
      bodyRows: [
        ['a', '5', 'gpt-5', '2026-06-15'],
        ['b', '1,250', 'claude-sonnet-4-5', 'today'],
      ],
      measureHeaderCells: ['Session', 'Total', 'Models', 'Newest'],
      measureBodyRows: [
        ['a', '5', 'gpt-5', '2026-06-15'],
        ['b', '1,250', 'claude-sonnet-4-5', 'today'],
      ],
      rowMetas: [createRowMeta(), createRowMeta()],
      columnKinds: ['text', 'measure', 'text', 'text'],
      multilineColumnIndex: 2,
    });

    expect(rendered.split('\n').slice(3, 5)).toEqual([
      '│ a       │     5 │ gpt-5             │ 2026-06-15 │',
      '│ b       │ 1,250 │ claude-sonnet-4-5 │ today      │',
    ]);
  });

  it('ends every listed measure at one shared right edge and leaves text unpadded', () => {
    const rows = [
      ['2026-01', '$0.50', '1', 'a long note that widens nothing else'],
      ['2026-02', '$12.25', '10', '-'],
    ];
    const rendered = renderUnicodeTable({
      headerCells: ['Period', 'Cost', 'Events', 'Notes'],
      bodyRows: rows,
      measureHeaderCells: ['Period', 'Cost', 'Events', 'Notes'],
      measureBodyRows: rows,
      rowMetas: [createRowMeta(), createRowMeta()],
      columnKinds: ['text', 'measure', 'measure', 'text'],
      multilineColumnIndex: 0,
      terminalWidth: 60,
    });

    expect(rendered.split('\n')).toEqual([
      '2026-01',
      '  Cost     $0.50',
      '  Events       1',
      '  Notes   a long note that widens nothing else',
      '',
      '2026-02',
      '  Cost    $12.25',
      '  Events      10',
      '  Notes   -',
    ]);
  });

  describe('fitting a table to the terminal', () => {
    const headers = ['Tool', 'Calls', 'Tokens', 'Top Project'];
    const tool = 'mcp__github__create_pull_request';
    const fullRows = [[tool, '1,250', '1,234,567', 'llm-usage-metrics']];
    const abbreviatedRows = [[tool, '1,250', '1.23M', 'llm-usage-metrics']];

    function renderAt(terminalWidth: number | undefined): string {
      return renderWithFitAt(terminalWidth).output;
    }

    function renderWithFitAt(terminalWidth: number | undefined) {
      return renderUnicodeTableWithFit({
        headerCells: headers,
        bodyRows: fullRows,
        measureHeaderCells: headers,
        measureBodyRows: fullRows,
        rowMetas: [createRowMeta()],
        columnKinds: ['text', 'measure', 'measure', 'text'],
        multilineColumnIndex: 0,
        terminalWidth,
        fit: { abbreviatedBodyRows: abbreviatedRows, hideableColumns: [3, 1] },
        stackedTitleColumnCount: 1,
      });
    }

    function columnsOf(rendered: string): string[] {
      return (rendered.split('\n')[1] ?? '')
        .split('│')
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0);
    }

    it('keeps full values while the full table fits, and without a terminal width', () => {
      for (const width of [undefined, 76]) {
        const rendered = renderAt(width);

        expect(columnsOf(rendered)).toEqual(headers);
        expect(rendered).toContain('1,234,567');
      }
    });

    it('abbreviates measures before hiding any column', () => {
      const rendered = renderAt(75);

      expect(columnsOf(rendered)).toEqual(headers);
      expect(rendered).toContain('│  1.23M │');
    });

    it('hides the hideable columns one at a time, in their given order', () => {
      expect(columnsOf(renderAt(72))).toEqual(['Tool', 'Calls', 'Tokens']);
      expect(columnsOf(renderAt(52))).toEqual(['Tool', 'Tokens']);
    });

    it('lists rows in full detail only when the narrowest step is still too wide', () => {
      expect(renderAt(44).split('\n')).toEqual([
        tool,
        '  Calls            1,250',
        '  Tokens       1,234,567',
        '  Top Project  llm-usage-metrics',
      ]);
    });

    it('reports the step it took, naming hidden columns by header', () => {
      expect(renderWithFitAt(76).fit).toEqual({
        abbreviatedTokens: false,
        hiddenHeaders: [],
        stacked: false,
      });
      expect(renderWithFitAt(75).fit).toMatchObject({ abbreviatedTokens: true, hiddenHeaders: [] });
      expect(renderWithFitAt(52).fit).toMatchObject({
        abbreviatedTokens: true,
        hiddenHeaders: ['Top Project', 'Calls'],
      });
      // A list shows every column in full, so it reports no other change.
      expect(renderWithFitAt(44).fit).toEqual({
        abbreviatedTokens: false,
        hiddenHeaders: [],
        stacked: true,
      });
    });

    it('never renders a boxed line wider than the terminal', () => {
      for (let width = 20; width <= 80; width += 1) {
        const lines = renderAt(width).split('\n');
        const isBoxed = lines[0]?.startsWith('╭') ?? false;

        if (isBoxed) {
          expect(Math.max(...lines.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(width);
        }
      }
    });
  });

  it('titles a listed row with its unwrapped text, so a wrapped path is not split by a space', () => {
    const path = '/home/user/.claude/projects/-home-user-projects-demo/session.jsonl';
    const wrappedPath = wrapTableColumn([[path]], { columnIndex: 0, width: 24 })[0][0];
    const rendered = renderUnicodeTable({
      headerCells: ['Path', 'Events'],
      bodyRows: [[wrappedPath, '12']],
      measureHeaderCells: ['Path', 'Events'],
      measureBodyRows: [[path, '12']],
      rowMetas: [createRowMeta()],
      columnKinds: ['text', 'measure'],
      multilineColumnIndex: 0,
      multilineColumnWidth: 24,
      terminalWidth: 20,
    });

    expect(rendered.split('\n')[0]).toBe(path);
  });

  it('keeps the fixed multiline width on its column when a column before it is hidden', () => {
    const rows = [['…3b0277334e93', '1,250', 'gpt-5']];
    const rendered = renderUnicodeTable({
      headerCells: ['Session', 'Calls', 'Models'],
      bodyRows: rows,
      measureHeaderCells: ['Session', 'Calls', 'Models'],
      measureBodyRows: rows,
      rowMetas: [createRowMeta()],
      columnKinds: ['text', 'measure', 'text'],
      multilineColumnIndex: 2,
      multilineColumnWidth: 12,
      terminalWidth: 30,
      fit: { hideableColumns: [0] },
    });

    expect(rendered.split('\n')[1]).toBe('│ Calls │ Models       │');
  });

  it('titles a listed row from its body cell when its measure row is short', () => {
    const rendered = renderUnicodeTable({
      headerCells: ['Name', 'Total'],
      bodyRows: [['alpha\nbeta', '1,234,567']],
      measureHeaderCells: ['Name', 'Total'],
      measureBodyRows: [[]],
      rowMetas: [createRowMeta()],
      columnKinds: ['text', 'measure'],
      multilineColumnIndex: 0,
      terminalWidth: 10,
    });

    expect(rendered.split('\n')[0]).toBe('alpha beta');
  });

  it('lists a value cell the table wrapped from its unwrapped lines, keeping every name whole', () => {
    const models = '• anthropic/claude-sonnet-4-5-20250929-thinking\n• gpt-5';
    const wrappedModels = wrapTableColumn([[models]], { columnIndex: 0, width: 32 })[0][0];
    const rendered = renderUnicodeTable({
      headerCells: ['Session', 'Models'],
      bodyRows: [['…3b0277334e93', wrappedModels]],
      measureHeaderCells: ['Session', 'Models'],
      measureBodyRows: [['…3b0277334e93', models]],
      rowMetas: [createRowMeta()],
      columnKinds: ['text', 'text'],
      multilineColumnIndex: 1,
      multilineColumnWidth: 32,
      terminalWidth: 40,
      stackedTitleColumnCount: 1,
    });

    expect(rendered.split('\n')).toEqual([
      '…3b0277334e93',
      '  Models  • anthropic/claude-sonnet-4-5-',
      '          20250929-thinking',
      '          • gpt-5',
    ]);
  });

  it('keeps the color of a one-line title when it lists rows', () => {
    const coloredSource = '\u001B[36mpi\u001B[39m';
    const rendered = renderUnicodeTable({
      headerCells: ['Source', 'Total'],
      bodyRows: [[coloredSource, '1,234,567']],
      measureHeaderCells: ['Source', 'Total'],
      measureBodyRows: [['pi', '1,234,567']],
      rowMetas: [createRowMeta()],
      columnKinds: ['text', 'measure'],
      multilineColumnIndex: 0,
      terminalWidth: 10,
    });

    expect(rendered.split('\n')[0]).toBe(coloredSource);
  });

  it('draws no rules between the rows of a flat list, only above its TOTAL row', () => {
    const rows = [
      ['a', '1'],
      ['b', '2'],
      ['TOTAL', '3'],
    ];
    const rendered = renderUnicodeTable({
      headerCells: ['Name', 'Count'],
      bodyRows: rows,
      measureHeaderCells: ['Name', 'Count'],
      measureBodyRows: rows,
      rowMetas: [
        createRowMeta({ periodKey: '' }),
        createRowMeta({ periodKey: '' }),
        createRowMeta({ periodKey: '', rowKind: 'total' }),
      ],
      columnKinds: ['text', 'measure'],
      multilineColumnIndex: 0,
    });

    expect(rendered.split('\n').slice(3, -1)).toEqual([
      '│ a     │     1 │',
      '│ b     │     2 │',
      '├───────┼───────┤',
      '│ TOTAL │     3 │',
    ]);
  });
});
