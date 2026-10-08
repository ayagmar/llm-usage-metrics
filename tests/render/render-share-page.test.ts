import { describe, expect, it } from 'vitest';

import { renderSharePage } from '../../src/render/render-share-page.js';
import { HOSTILE_TEXT } from './share-svg-assertions.js';

function renderPage(): string {
  return renderSharePage({
    title: HOSTILE_TEXT,
    fileBaseName: 'usage-daily-share',
    svgs: { dark: '<svg data-theme="dark"/>', light: '<svg data-theme="light"/>' },
  });
}

describe('renderSharePage', () => {
  it('embeds both themes with the theme toggle and export buttons', () => {
    const page = renderPage();

    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<figure data-card="dark">\n<svg data-theme="dark"/>');
    expect(page).toContain('<figure data-card="light" hidden>\n<svg data-theme="light"/>');
    expect(page).toContain('data-theme-choice="dark"');
    expect(page).toContain('data-theme-choice="light"');
    expect(page).toContain('>Download PNG</button>');
    expect(page).toContain('>Copy image</button>');
    expect(page).toContain('data-file-base-name="usage-daily-share"');
  });

  it('exports at twice the card size', () => {
    const page = renderPage();

    expect(page).toContain('canvas.width = 1200 * scale;');
    expect(page).toContain('canvas.height = 630 * scale;');
    expect(page).toContain('const scale = 2;');
  });

  it('is self-contained: a restrictive CSP and no external URLs', () => {
    const page = renderPage();

    expect(page).toContain(
      `content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"`,
    );
    expect(page).not.toMatch(/(?:src|href)="https?:/u);
    expect(page).not.toContain('@import');
  });

  it('escapes the title and file name', () => {
    const page = renderSharePage({
      title: HOSTILE_TEXT,
      fileBaseName: '"><script>x</script>',
      svgs: { dark: '<svg/>', light: '<svg/>' },
    });

    expect(page).toContain('<title>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(page.match(/<script>/gu)).toHaveLength(1);
  });
});
