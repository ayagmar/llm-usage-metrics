// The chart slot. Each chart registers here (`models.ts` holds the list); the shell gives every entry a
// titled figure with PNG, SVG and copy-as-image buttons, in list order, and calls `render`
// again whenever the view changes.
//
// A chart's contract:
// - `render` replaces the content of `body` from the context alone (view, selected cells,
//   labels); it never reads the URL, the DOM outside `body`, or global state.
// - The first `<svg>` in `body` is what export captures. Style it with classes and SVG
//   presentation attributes (the CSP allows no `style` attribute); export inlines the computed
//   colours and fonts. Give it a `viewBox`.
// - Labels come from `context.labels`, so "Hide names" masks them on screen and in exports.
// - Each chart carries its numbers as text too: direct labels or a table equivalent in `body`.

import type { ShareViewContext } from '../state/context.js';
import { CHART_MODELS } from './models.js';
import { chartRenderer } from './mount.js';

export type ShareChart = {
  /** Stable and URL-safe: names the figure's element id and export file names. */
  id: string;
  title: string;
  render: (body: HTMLElement, context: ShareViewContext) => void;
};

export const SHARE_CHARTS: readonly ShareChart[] = CHART_MODELS.map((model) => ({
  id: model.id,
  title: model.title,
  render: chartRenderer(model.build),
}));
