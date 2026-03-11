import { describe, expect, it } from 'vitest';

import { toMarkdownSafeCell } from '../../src/render/markdown-safe-cell.js';

describe('toMarkdownSafeCell', () => {
  it('escapes bare URLs and email addresses so markdown stays data-only', () => {
    const output = toMarkdownSafeCell('https://example.com\nwww.example.com\nuser@example.com');

    expect(output).toContain('https\\://example.com');
    expect(output).toContain('www\\.example.com');
    expect(output).toContain('user\\@example.com');
    expect(output).not.toContain('https://example.com');
    expect(output).not.toContain('www.example.com');
    expect(output).not.toContain('user@example.com');
  });
});
