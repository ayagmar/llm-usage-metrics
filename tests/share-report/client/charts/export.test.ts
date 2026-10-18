import { describe, expect, it } from 'vitest';

import { getDefaultViewState } from '../../../../src/share-report/client/core/index.js';
import { CHART_MODELS } from '../../../../src/share-report/client/ui/charts/models.js';
import type { ChartView, SvgNode } from '../../../../src/share-report/client/ui/charts/svg.js';
import {
  getSvgSize,
  serializeSvgForExport,
  type ExportNode,
} from '../../../../src/share-report/client/ui/export/svg-export.js';
import {
  buildViewContext,
  createLabels,
} from '../../../../src/share-report/client/ui/state/context.js';
import { loadFixtureReport } from '../core/share-fixture.js';

// What the browser computes for a chart element: CSS colours for the classes charts.css paints,
// the url() a hatch overlay keeps, and the font for text. A stand-in for getComputedStyle.
function computedFor(node: SvgNode): Record<string, string> {
  const className = typeof node.attrs.class === 'string' ? node.attrs.class : '';
  const computed: Record<string, string> = {};

  if (/^(?:series|heat)-/u.test(className)) {
    computed.fill = 'rgb(182, 83, 49)';
  } else if (typeof node.attrs.fill === 'string') {
    // Chrome serialises a url() fill with quotes.
    computed.fill = node.attrs.fill.replace(/^url\(#(.+)\)$/u, 'url("#$1")');
  } else if (className === 'chart-hatch') {
    computed.fill = 'none';
    computed.stroke = 'rgb(251, 249, 244)';
  }

  if (node.tag === 'text') {
    computed.fill = 'rgb(32, 35, 29)';
    computed['font-family'] = 'system-ui, sans-serif';
    computed['font-size'] = `${String(node.attrs['font-size'])}px`;
  }

  return computed;
}

function toExportNode(node: SvgNode): ExportNode {
  return {
    tag: node.tag,
    attributes: Object.entries(node.attrs).map(([name, value]) => [name, String(value)] as const),
    computed: computedFor(node),
    children: node.children.map((child) =>
      typeof child === 'string' ? child : toExportNode(child),
    ),
  };
}

function svgOf(view: ChartView): SvgNode {
  if (!view.svg) {
    throw new Error(`Nothing drawn: ${view.message ?? ''}`);
  }

  return view.svg;
}

describe('chart export', () => {
  const report = loadFixtureReport();
  const context = buildViewContext(
    report,
    getDefaultViewState(report),
    createLabels(report, undefined),
    'dark',
  );

  for (const model of CHART_MODELS) {
    it(`writes ${model.id} as a standalone SVG with no class, variable or style`, () => {
      const view = model.build(context, 720);
      const root = toExportNode(svgOf(view));
      const file = serializeSvgForExport(root, 'rgb(21, 23, 19)');

      expect(getSvgSize(root)?.width).toBe(720);
      expect(file).toMatch(
        /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="752" height="\d+(\.\d+)?" viewBox="-16 -16 752 /u,
      );
      expect(file).not.toMatch(/\sclass=|\sstyle=|var\(|\srole=|aria-/u);

      // Every hatch the file paints with is defined in the same file.
      const referenced = [...file.matchAll(/url\(&quot;#([^&]+)&quot;\)/gu)].map(
        (match) => match[1],
      );
      for (const id of referenced) {
        expect(file).toContain(`<pattern id="${id}"`);
      }
    });
  }

  it('keeps the hatch lines painted inside their patterns', () => {
    const view = CHART_MODELS[0].build(context, 720);
    const file = serializeSvgForExport(toExportNode(svgOf(view)), 'rgb(21, 23, 19)');

    expect(file).toMatch(
      /<pattern id="cost-over-time-hatch-2"[^>]*><path d="M0 0V5" fill="none" stroke="rgb\(251, 249, 244\)"\/><\/pattern>/u,
    );
    expect(file).toContain('fill="url(&quot;#cost-over-time-hatch-2&quot;)"');
  });
});
