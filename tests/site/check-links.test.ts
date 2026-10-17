import { describe, expect, it } from 'vitest';

import {
  classifyLink,
  extractIds,
  extractLinks,
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
