import { describe, expect, it } from 'vitest';

import {
  toHtmlSafeCodeCell,
  toHtmlSafeText,
  toMarkdownSafeCell,
} from '../../src/render/markdown-safe-cell.js';

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

  it('escapes HTML syntax without adding markdown escape characters', () => {
    const output = toHtmlSafeText('flag <value> | & more');

    expect(output).toBe('flag &lt;value&gt; | &amp; more');
  });

  it('wraps HTML-escaped code cell content in code tags', () => {
    const output = toHtmlSafeCodeCell('--filter <value>|literal`tick`');

    expect(output).toBe('<code>--filter &lt;value&gt;|literal`tick`</code>');
    expect(output).not.toContain('\\|');
  });
});
