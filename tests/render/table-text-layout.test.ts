import { describe, expect, it } from 'vitest';

import {
  resolveTtyColumns,
  truncateMiddle,
  truncateTableColumn,
  visibleWidth,
  wrapTableColumn,
} from '../../src/render/table-text-layout.js';

describe('table-text-layout', () => {
  it('measures visible width while ignoring ansi sequences', () => {
    expect(visibleWidth('\u001B[31mhello\u001B[39m')).toBe(5);
  });

  it('counts full-width unicode characters as width 2', () => {
    expect(visibleWidth('漢字')).toBe(4);
  });

  it('counts emoji graphemes as width 2', () => {
    expect(visibleWidth('😀')).toBe(2);
    expect(visibleWidth('👨‍👩‍👦')).toBe(2);
    expect(visibleWidth('🇺🇸')).toBe(2);
    expect(visibleWidth('1️⃣')).toBe(2);
  });

  it('treats text-presentation symbols as width 1 unless emoji presentation is requested', () => {
    expect(visibleWidth('©®™ℹ☺✈')).toBe(6);
    expect(visibleWidth('©️')).toBe(2);
    expect(visibleWidth('™️')).toBe(2);
    expect(visibleWidth('✈️')).toBe(2);
  });

  it('treats common format zero-width code points as width 0', () => {
    expect(visibleWidth('a\u200Bb\u2060c\uFEFFd')).toBe(4);
  });

  it('wraps at spaces when possible', () => {
    const wrappedRows = wrapTableColumn([['period', 'source', 'hello world']], {
      columnIndex: 2,
      width: 5,
    });

    expect(wrappedRows[0][2]).toBe('hello\nworld');
  });

  it('wraps long words by width when there are no spaces', () => {
    const wrappedRows = wrapTableColumn([['period', 'source', 'abcdefghij']], {
      columnIndex: 2,
      width: 4,
    });

    expect(wrappedRows[0][2]).toBe('abcd\nefgh\nij');
  });

  it('requires a positive wrap width', () => {
    expect(() =>
      wrapTableColumn([['period', 'source', 'text']], {
        columnIndex: 2,
        width: 0,
      }),
    ).toThrow('wrapTableColumn width must be greater than 0');
  });

  it('does not split emoji grapheme clusters while wrapping', () => {
    const wrappedRows = wrapTableColumn([['period', 'source', '👨‍👩‍👦👨‍👩‍👦']], {
      columnIndex: 2,
      width: 2,
    });

    expect(wrappedRows[0][2]).toBe('👨‍👩‍👦\n👨‍👩‍👦');
  });

  it('normalizes CRLF and CR line breaks before wrapping', () => {
    const wrappedRows = wrapTableColumn([['period', 'source', 'alpha\r\nbeta\rgamma']], {
      columnIndex: 2,
      width: 16,
    });

    expect(wrappedRows[0][2]).toBe('alpha\nbeta\ngamma');
  });

  it('resolves tty columns only when stream is a tty and width is valid', () => {
    expect(resolveTtyColumns({ isTTY: true, columns: 132 })).toBe(132);
    expect(resolveTtyColumns({ isTTY: true, columns: 80.9 })).toBe(80);
  });

  it('returns undefined for non-tty or invalid tty columns', () => {
    expect(resolveTtyColumns({ isTTY: false, columns: 120 })).toBeUndefined();
    expect(resolveTtyColumns({ isTTY: true, columns: 0 })).toBeUndefined();
    expect(resolveTtyColumns({ isTTY: true, columns: -1 })).toBeUndefined();
    expect(resolveTtyColumns({ isTTY: true, columns: Number.NaN })).toBeUndefined();
    expect(resolveTtyColumns({ isTTY: true, columns: undefined })).toBeUndefined();
  });

  it('shortens long lines with a middle ellipsis that keeps both ends', () => {
    expect(truncateMiddle('• claude-opus-5-5-medium', 24)).toBe('• claude-opus-5-5-medium');
    expect(truncateMiddle('• claude-haiku-4-5-20251001', 20)).toBe('• claude-h…-20251001');
    expect(visibleWidth(truncateMiddle('• claude-haiku-4-5-20251001', 20))).toBe(20);
    expect(truncateMiddle('abc', 1)).toBe('…');
    expect(truncateMiddle('abc', 0)).toBe('');
  });

  it('never splits wide graphemes when shortening', () => {
    const shortened = truncateMiddle('模型模型模型模型', 8);

    expect(visibleWidth(shortened)).toBeLessThanOrEqual(8);
    expect(shortened).toBe('模型…型');
  });

  it('shortens each line of one table column', () => {
    expect(
      truncateTableColumn([['2026-01', 'alpha-model-name\nbeta', '10']], {
        columnIndex: 1,
        width: 9,
      }),
    ).toEqual([['2026-01', 'alph…name\nbeta', '10']]);
  });
});
