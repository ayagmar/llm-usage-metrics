import { describe, expect, it } from 'vitest';

import {
  getExportFileName,
  getRasterSize,
  getSvgSize,
  serializeSvgForExport,
  SVG_NAMESPACE,
  type ExportNode,
} from '../../../../src/share-report/client/ui/export/svg-export.js';

function node(
  tag: string,
  attributes: Record<string, string>,
  computed: Record<string, string>,
  children: (ExportNode | string)[] = [],
): ExportNode {
  return { tag, attributes: Object.entries(attributes), computed, children };
}

const TEXT_STYLE = {
  fill: 'rgb(32, 35, 29)',
  'font-family': '"Segoe UI", system-ui',
  'font-size': '12px',
  'font-weight': '600',
  'text-anchor': 'start',
};

function chart(): ExportNode {
  return node(
    'svg',
    { viewBox: '0 0 400 200', class: 'chart-svg', role: 'img', 'aria-label': 'Cost' },
    {},
    [
      node('title', {}, {}, ['Cost & tokens']),
      node('g', { class: 'series', fill: 'var(--series-1)' }, { fill: 'rgb(182, 83, 49)' }, [
        node(
          'rect',
          {
            x: '0',
            y: '10',
            width: '20',
            height: '40',
            class: 'bar',
            fill: 'red',
            'data-key': 'x',
          },
          { fill: 'rgb(182, 83, 49)', stroke: 'none', opacity: '1', 'font-size': '12px' },
        ),
        node('rect', { x: '30', class: 'hidden' }, { display: 'none', fill: 'red' }),
      ]),
      node('text', { x: '4', y: '190', class: 'axis' }, TEXT_STYLE, ['<10 & up>']),
    ],
  );
}

describe('serializeSvgForExport', () => {
  const svg = serializeSvgForExport(chart(), 'rgb(251, 249, 244)');

  it('leaves no class, style, CSS variable or page-only attribute in the file', () => {
    expect(svg).not.toMatch(/\bclass=|\bstyle=|var\(|data-|aria-|\brole=/u);
  });

  it('writes computed colours and fonts as presentation attributes', () => {
    expect(svg).toContain('<rect x="0" y="10" width="20" height="40" fill="rgb(182, 83, 49)"/>');
    expect(svg).toContain(
      '<text x="4" y="190" fill="rgb(32, 35, 29)" font-family="&quot;Segoe UI&quot;, system-ui" font-size="12px" font-weight="600">',
    );
  });

  it('is a standalone, sized file on the page background', () => {
    expect(
      svg.startsWith(
        `<svg xmlns="${SVG_NAMESPACE}" width="400" height="200" viewBox="0 0 400 200">`,
      ),
    ).toBe(true);
    expect(svg).toContain('<rect width="100%" height="100%" fill="rgb(251, 249, 244)"/>');
  });

  it('escapes text and drops what the page does not draw', () => {
    expect(svg).toContain('&lt;10 &amp; up&gt;');
    expect(svg).toContain('<title>Cost &amp; tokens</title>');
    expect(svg).not.toContain('x="30"');
  });

  it('keeps the case of SVG tag names and skips an unusable background', () => {
    const gradient = serializeSvgForExport(
      node('svg', { width: '10', height: '10' }, {}, [
        node('linearGradient', { id: 'g' }, {}, [node('stop', { offset: '0' }, {})]),
      ]),
      'var(--surface)',
    );

    expect(gradient).toBe(
      `<svg xmlns="${SVG_NAMESPACE}" width="10" height="10"><linearGradient id="g"><stop offset="0"/></linearGradient></svg>`,
    );
  });
});

describe('export sizes and names', () => {
  it('reads the size from width and height, else the viewBox', () => {
    expect(getSvgSize(node('svg', { width: '300', height: '150' }, {}))).toEqual({
      width: 300,
      height: 150,
    });
    expect(getSvgSize(node('svg', { viewBox: '0,0 640 360' }, {}))).toEqual({
      width: 640,
      height: 360,
    });
    expect(getSvgSize(node('svg', { viewBox: '0 0 0 10' }, {}))).toBeUndefined();
  });

  it('doubles the size for PNG but stays inside what a canvas can hold', () => {
    expect(getRasterSize({ width: 640, height: 360 })).toEqual({ width: 1280, height: 720 });
    expect(getRasterSize({ width: 10_000, height: 100 })).toEqual({ width: 8192, height: 82 });
  });

  it('names the file after the report, the chart and the theme shown', () => {
    expect(getExportFileName('usage-daily-share', 'cost-over-time', 'dark', 'png')).toBe(
      'usage-daily-share-cost-over-time-dark.png',
    );
  });
});
