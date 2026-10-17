import { describe, expect, it } from 'vitest';

import {
  classifyLink,
  extractIds,
  extractLinks,
  splitSrcset,
  toDistCandidates,
} from '../../site/scripts/lib/links.mjs';

const BASE = '/llm-usage-metrics/';

describe('extractLinks', () => {
  it('reads href and src values from start tags, decoding entities', () => {
    const html = `<a href="/llm-usage-metrics/a/?x=1&amp;y=2">A</a>
      <img alt="x" src='/llm-usage-metrics/img.webp'><link rel=icon href=/llm-usage-metrics/favicon.svg>`;
    expect(extractLinks(html)).toEqual([
      '/llm-usage-metrics/a/?x=1&y=2',
      '/llm-usage-metrics/favicon.svg',
      '/llm-usage-metrics/img.webp',
    ]);
  });

  it('skips scripts, styles, comments and attribute-like text', () => {
    const html = `<script>el.innerHTML = '<a href="/nope/">'</script>
      <style>a[href="/nope/"] {}</style><!-- <a href="/nope/"> -->
      <pre><code>&lt;a href="/nope/"&gt; and data-href="/nope/"</code></pre>
      <a data-href="/nope/" href="/llm-usage-metrics/ok/">ok</a>`;
    expect(extractLinks(html)).toEqual(['/llm-usage-metrics/ok/']);
  });

  it('reads attributes with whitespace around = and upper-case names', () => {
    const html = `<a href = "/llm-usage-metrics/a/">A</a><a
      HREF
        =
      '/llm-usage-metrics/b/'>B</a><img src =/llm-usage-metrics/c.webp alt=c>`;
    expect(extractLinks(html)).toEqual([
      '/llm-usage-metrics/a/',
      '/llm-usage-metrics/b/',
      '/llm-usage-metrics/c.webp',
    ]);
  });

  it('does not read href= inside another attribute value', () => {
    const html = `<a title="see href=/nope/" data-x='src = "/nope/"' href="/llm-usage-metrics/ok/">ok</a>`;
    expect(extractLinks(html)).toEqual(['/llm-usage-metrics/ok/']);
  });

  it('reads every candidate URL of srcset on img and source', () => {
    const html = `<picture><source type="image/avif" srcset="/llm-usage-metrics/_astro/a.avif 1x, /llm-usage-metrics/_astro/a@2.avif 2x">
      <img src="/llm-usage-metrics/_astro/a.webp" srcset="/llm-usage-metrics/_astro/a-640.webp 640w,/llm-usage-metrics/_astro/a-1280.webp 1280w"></picture>`;
    expect(extractLinks(html)).toEqual([
      '/llm-usage-metrics/_astro/a.webp',
      '/llm-usage-metrics/_astro/a.avif',
      '/llm-usage-metrics/_astro/a@2.avif',
      '/llm-usage-metrics/_astro/a-640.webp',
      '/llm-usage-metrics/_astro/a-1280.webp',
    ]);
  });
});

describe('splitSrcset', () => {
  it('keeps commas inside a URL and drops descriptors and trailing commas', () => {
    expect(splitSrcset(' /a.webp?x=1,2 2x ,/b.webp,, /c.webp 640w, ')).toEqual([
      '/a.webp?x=1,2',
      '/b.webp',
      '/c.webp',
    ]);
  });
});

describe('extractIds', () => {
  it('collects id attributes but not data-id', () => {
    const ids = extractIds('<h2 id="setup">S</h2><div data-id="x" id=\'run-it\'></div>');
    expect([...ids]).toEqual(['setup', 'run-it']);
  });
});

describe('classifyLink', () => {
  const page = '/llm-usage-metrics/reports/';

  it('ignores other origins, mailto and similar schemes', () => {
    expect(classifyLink('https://github.com/x', page)).toEqual({ kind: 'external' });
    expect(classifyLink('//cdn.example.com/a.js', page)).toEqual({ kind: 'external' });
    expect(classifyLink('mailto:someone@example.com', page)).toEqual({ kind: 'ignored' });
    expect(classifyLink('tel:123', page)).toEqual({ kind: 'ignored' });
    expect(classifyLink('data:image/png;base64,AAA', page)).toEqual({ kind: 'ignored' });
    expect(classifyLink('', page)).toEqual({ kind: 'ignored' });
  });

  it('resolves absolute, relative and fragment-only links against the page', () => {
    expect(classifyLink('/llm-usage-metrics/usage/#hourly', page)).toEqual({
      kind: 'internal',
      path: '/llm-usage-metrics/usage/',
      fragment: 'hourly',
    });
    expect(classifyLink('../blocks/', page)).toEqual({
      kind: 'internal',
      path: '/llm-usage-metrics/blocks/',
      fragment: null,
    });
    expect(classifyLink('#options', page)).toEqual({
      kind: 'internal',
      path: page,
      fragment: 'options',
    });
  });

  it('decodes fragments and treats a bare # as no fragment', () => {
    expect(classifyLink('#caf%C3%A9', page)).toMatchObject({ fragment: 'café' });
    expect(classifyLink('/llm-usage-metrics/a/#', page)).toMatchObject({ fragment: null });
    expect(classifyLink('/llm-usage-metrics/a/?q=1', page)).toMatchObject({
      path: '/llm-usage-metrics/a/',
    });
  });
});

describe('toDistCandidates', () => {
  it('maps the base and directory URLs to index.html', () => {
    expect(toDistCandidates('/llm-usage-metrics/', BASE)).toEqual(['index.html']);
    expect(toDistCandidates('/llm-usage-metrics', BASE)).toEqual(['index.html']);
    expect(toDistCandidates('/llm-usage-metrics/library/guide/', BASE)).toEqual([
      'library/guide/index.html',
    ]);
  });

  it('tries the file, .html and a directory index for other paths', () => {
    expect(toDistCandidates('/llm-usage-metrics/demo/report.html', BASE)).toEqual([
      'demo/report.html',
      'demo/report.html.html',
      'demo/report.html/index.html',
    ]);
    expect(toDistCandidates('/llm-usage-metrics/usage', BASE)).toEqual([
      'usage',
      'usage.html',
      'usage/index.html',
    ]);
  });

  it('rejects paths outside the base', () => {
    expect(toDistCandidates('/other/', BASE)).toBeNull();
    expect(toDistCandidates('/llm-usage-metrics-old/', BASE)).toBeNull();
  });
});
