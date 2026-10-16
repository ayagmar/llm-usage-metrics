import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  SHARE_CLIENT_SCRIPT,
  SHARE_CLIENT_SCRIPT_HASH,
  SHARE_CLIENT_STYLE,
  SHARE_CLIENT_STYLE_HASH,
} from '../../src/share-report/client-bundle.generated.js';
import {
  parseSavedView,
  renderShareDocument,
  serializeSavedView,
} from '../../src/share-report/client/ui/export/share-document.js';
import { SVG_NAMESPACE } from '../../src/share-report/client/ui/export/svg-export.js';
import { renderShareHtml } from '../../src/share-report/render-share-html.js';
import { readFixturePayload } from './client/core/share-fixture.js';

function cspHash(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

function between(html: string, open: string, close: string): string {
  const start = html.indexOf(open);
  const end = html.indexOf(close, start + open.length);

  if (start < 0 || end < 0) {
    throw new Error(`Missing ${open}`);
  }

  return html.slice(start + open.length, end);
}

/** What the browser reads back: the CSP, the one style, the one executable script, the JSON blocks. */
function readParts(html: string) {
  return {
    csp: decodeAttribute(
      between(html, '<meta http-equiv="Content-Security-Policy" content="', '">'),
    ),
    style: between(html, '<style>', '</style>'),
    script: between(html, '\n<script>', '</script>'),
    payload: between(html, '<script type="application/json" id="report-data">', '</script>'),
    title: between(html, '<title>', '</title>'),
  };
}

/** An attribute value as the browser reads it. */
function decodeAttribute(value: string): string {
  return value
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** The markup with the executable script's text left out: what the HTML parser sees as tags. */
function markupOnly(html: string): string {
  const parts = readParts(html);
  return html.replace(parts.script, '');
}

function cspSource(csp: string, directive: string): string {
  const entry = csp.split('; ').find((part) => part.startsWith(`${directive} `));
  return (entry ?? '').slice(directive.length + 1);
}

function renderFixture(edit?: (data: ReturnType<typeof readFixturePayload>['data']) => void) {
  const payload = readFixturePayload();
  edit?.(payload.data);
  return {
    payload,
    html: renderShareHtml({ data: payload.data, fileBaseName: 'usage-daily-share' }),
  };
}

describe('renderShareHtml', () => {
  it('lets only the embedded script and style run, by hash', () => {
    const { html } = renderFixture();
    const parts = readParts(html);

    expect(parts.script).toBe(SHARE_CLIENT_SCRIPT);
    expect(parts.style).toBe(SHARE_CLIENT_STYLE);
    expect(cspSource(parts.csp, 'script-src')).toBe(`'${cspHash(parts.script)}'`);
    expect(cspSource(parts.csp, 'style-src')).toBe(`'${cspHash(parts.style)}'`);
    expect(cspSource(parts.csp, 'script-src')).toBe(`'${SHARE_CLIENT_SCRIPT_HASH}'`);
    expect(cspSource(parts.csp, 'style-src')).toBe(`'${SHARE_CLIENT_STYLE_HASH}'`);
    expect(parts.csp).toContain("default-src 'none'");
    expect(parts.csp).toContain('img-src blob:');
    expect(parts.csp).toContain("base-uri 'none'");
    expect(parts.csp).toContain("form-action 'none'");
  });

  it('puts the CSP before any style or script', () => {
    const { html } = renderFixture();
    const csp = html.indexOf('Content-Security-Policy');

    expect(csp).toBeGreaterThan(0);
    expect(csp).toBeLessThan(html.indexOf('<style'));
    expect(csp).toBeLessThan(html.indexOf('<script'));
  });

  it('holds exactly one style, one executable script and no inline styling', () => {
    const { html } = renderFixture();
    const markup = markupOnly(html);

    expect(markup.match(/<style\b/gu)).toHaveLength(1);
    expect(markup.match(/<script>/gu)).toHaveLength(1);
    expect(markup.match(/<script\b/gu)).toHaveLength(2);
    expect(html).not.toMatch(/\sstyle\s*=/iu);
    expect(markup).not.toMatch(/\son[a-z]+\s*=/iu);
  });

  it('refers to no URL except the SVG namespace, which is never fetched', () => {
    const { html } = renderFixture();
    const urls = html.match(/[a-z][a-z\d+.-]*:\/\/[^\s"'<>)\\]*/giu) ?? [];

    expect(urls.filter((url) => url !== SVG_NAMESPACE)).toEqual([]);
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?\/\//iu);
    expect(readParts(html).style).not.toMatch(/@import|url\(\s*["']?(?!#)/iu);
  });

  it('embeds a payload that labels cannot break out of, and that reads back unchanged', () => {
    const hostile = 'x</script><!--<script>\u2028\u2029';
    const { payload, html } = renderFixture((data) => {
      data.dictionaries.projects[0] = hostile;
    });
    const parts = readParts(html);

    for (const character of ['<', '\u2028', '\u2029']) {
      expect(parts.payload).not.toContain(character);
    }
    expect(JSON.parse(parts.payload)).toEqual({ ...payload });
    expect(html.match(/<\/script/giu)).toHaveLength(2);
  });

  it('titles the page after the command, escaped', () => {
    const { html } = renderFixture((data) => {
      data.meta.command = 'wrapped';
    });

    expect(readParts(html).title).toBe('Wrapped 2026 · llm-usage-metrics');
    expect(
      readParts(
        renderShareHtml({
          data: readFixturePayload().data,
          fileBaseName: 'a"b',
          title: '<Mine> & "yours"',
        }),
      ).title,
    ).toBe('&lt;Mine&gt; &amp; &quot;yours&quot;');
  });

  it('rebuilds a saved view whose hashes still match its script and style', () => {
    const { html } = renderFixture();
    const parts = readParts(html);
    const saved = renderShareDocument({
      title: 'Daily usage · llm-usage-metrics',
      fileBaseName: 'usage-daily-share',
      contentSecurityPolicy: parts.csp,
      style: parts.style,
      script: parts.script,
      payloadJson: parts.payload,
      viewStateJson: serializeSavedView('g=week&src=1&proj=0.2'),
    });
    const savedParts = readParts(saved);

    expect(cspSource(savedParts.csp, 'script-src')).toBe(`'${cspHash(savedParts.script)}'`);
    expect(cspSource(savedParts.csp, 'style-src')).toBe(`'${cspHash(savedParts.style)}'`);
    expect(savedParts.csp).toBe(parts.csp);
    expect(savedParts.payload).toBe(parts.payload);
    expect(
      parseSavedView(
        between(saved, '<script type="application/json" id="view-state">', '</script>'),
      ),
    ).toBe('g=week&src=1&proj=0.2');
    // The file is the generated one plus the view-state block, byte for byte.
    expect(
      saved.replace(/<script type="application\/json" id="view-state">.*?<\/script>\n/u, ''),
    ).toBe(html);
  });
});
