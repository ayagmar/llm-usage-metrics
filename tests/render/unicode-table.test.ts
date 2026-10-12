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

  it('lists rows as labelled values when the table is wider than the terminal', () => {
    const rendered = renderUnicodeTable({
      headerCells: ['Session', 'Source', 'Cost', 'Models'],
      bodyRows: [['…3b0277334e93', 'codex', '', 'gpt-5.4\nclaude-opus-4-8']],
      measureHeaderCells: ['Session', 'Source', 'Cost', 'Models'],
      measureBodyRows: [['…3b0277334e93', 'codex', '', 'gpt-5.4\nclaude-opus-4-8']],
      rowMetas: [createRowMeta()],
      layout: 'top_aligned',
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
      multilineColumnIndex: 1,
      multilineColumnWidth: 12,
    });
    const topBorder = rendered.split('\n')[0] ?? '';

    expect((topBorder.match(/┬/g) ?? []).length).toBe(2);
    expect(rendered).not.toContain('undefined');
  });
});
