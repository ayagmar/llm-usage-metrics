import { describe, expect, it } from 'vitest';

import { toMarkdownSafeCell, toMarkdownSafeCodeCell } from '../../src/render/markdown-safe-cell.js';

describe('markdown-safe-cell', () => {
  it('escapes bare URLs and email addresses so markdown stays data-only', () => {
    const output = toMarkdownSafeCell('https://example.com\nwww.example.com\nuser@example.com');

    expect(output).toContain('https\\://example.com');
    expect(output).toContain('www\\.example.com');
    expect(output).toContain('user\\@example.com');
    expect(output).not.toContain('https://example.com');
    expect(output).not.toContain('www.example.com');
    expect(output).not.toContain('user@example.com');
  });

  it('escapes HTML syntax for normal markdown text cells', () => {
    const output = toMarkdownSafeCell('flag <value> | & more');

    expect(output).toBe('flag &lt;value&gt; \\| &amp; more');
  });

  it('wraps code cell content in markdown code spans and escapes table pipes', () => {
    const output = toMarkdownSafeCodeCell('--filter <value>|literal');

    expect(output).toBe('`--filter <value>\\|literal`');
    expect(output).not.toContain('<code>');
  });

  it('uses a longer markdown fence when code content already contains backticks', () => {
    const output = toMarkdownSafeCodeCell('literal`tick`|pipe');

    expect(output).toBe('``literal`tick`\\|pipe``');
  });

  it('pads markdown code fences when content starts or ends with backticks or whitespace', () => {
    expect(toMarkdownSafeCodeCell('`code`')).toBe('`` `code` ``');
    expect(toMarkdownSafeCodeCell(' leading')).toBe('`  leading `');
    expect(toMarkdownSafeCodeCell('trailing ')).toBe('` trailing  `');
  });
});
