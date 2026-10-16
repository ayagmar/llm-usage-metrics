// The panel slot. Each panel registers here (C3 fills the list); the shell gives every panel
// that applies to the file a titled section, in list order, and calls `render` again whenever
// the view changes.
//
// A panel's contract:
// - `appliesTo` decides from the report alone, e.g. by `report.data.envelope?.report`.
// - `placement: 'recap'` sits above the controls (wrapped's recap header); `'section'` sits
//   after the charts.
// - `render` replaces the content of `body` from the context alone and shows project and
//   machine names through `context.labels` ("Hide names").
// - Styling through classes only (the CSP allows no `style` attribute).

import type { ShareReport } from '../../core/index.js';
import type { PanelPlacement } from '../shell/model.js';
import type { ShareViewContext } from '../state/context.js';
import { embeds } from './model.js';
import {
  renderComparePanel,
  renderEfficiencyPanel,
  renderOptimizePanel,
  renderWrappedPanel,
} from './render.js';

export type SharePanel = {
  /** Stable and URL-safe: names the section's element id. */
  id: string;
  title: string;
  placement: PanelPlacement;
  appliesTo: (report: ShareReport) => boolean;
  render: (body: HTMLElement, context: ShareViewContext) => void;
};

export const SHARE_PANELS: readonly SharePanel[] = [
  {
    id: 'wrapped-recap',
    title: 'Year in review',
    placement: 'recap',
    appliesTo: embeds('wrapped'),
    render: renderWrappedPanel,
  },
  {
    id: 'compare',
    title: 'Current against baseline',
    placement: 'section',
    appliesTo: embeds('compare'),
    render: renderComparePanel,
  },
  {
    id: 'efficiency',
    title: 'Cost against commits',
    placement: 'section',
    appliesTo: embeds('efficiency'),
    render: renderEfficiencyPanel,
  },
  {
    id: 'optimize',
    title: 'Candidate models',
    placement: 'section',
    appliesTo: embeds('optimize'),
    render: renderOptimizePanel,
  },
];
