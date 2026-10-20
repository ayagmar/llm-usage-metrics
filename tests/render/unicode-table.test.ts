import { describe, expect, it } from 'vitest';

import { renderUnicodeTable, type TableRowMeta } from '../../src/render/unicode-table.js';

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
      layout: 'top_aligned',
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
      layout: 'top_aligned',
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
      layout: 'top_aligned',
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
      layout: 'compact',
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
      layout: 'compact',
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
      layout: 'compact',
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
      layout: 'compact',
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
      layout: 'compact',
      columnKinds: ['text', 'measure', 'text', 'text'],
      multilineColumnIndex: 2,
    });

    expect(rendered.split('\n').slice(3, 6)).toEqual([
      '│ a       │     5 │ gpt-5             │ 2026-06-15 │',
      '├─────────┼───────┼───────────────────┼────────────┤',
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
      layout: 'compact',
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
});
