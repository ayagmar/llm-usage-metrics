// The panel slot. Each command with its own report registers a lead here; the shell gives
// every panel that applies to the file a titled section above the controls, in list order,
// and calls `render` again whenever the view changes. The page opens on what its command is
// about; the controls and charts below are for digging in.
//
// A panel's contract:
// - `appliesTo` decides from the report alone, e.g. by `report.data.envelope?.report`.
// - `render` replaces the content of `body` from the context alone and shows project and
//   machine names through `context.labels` ("Hide names").
// - Styling through classes only (the CSP allows no `style` attribute).

import type { ShareReport } from '../../core/index.js';
import type { ShareViewContext } from '../state/context.js';
import { embeds } from './model.js';
import {
  renderComparePanel,
  renderEfficiencyPanel,
  renderOptimizePanel,
  renderSummaryPanel,
  renderTrendsPanel,
  renderWrappedPanel,
} from './render.js';

export type SharePanel = {
  /** Stable and URL-safe: names the section's element id. */
  id: string;
  title: string;
  appliesTo: (report: ShareReport) => boolean;
  render: (body: HTMLElement, context: ShareViewContext) => void;
};

export const SHARE_PANELS: readonly SharePanel[] = [
  {
    id: 'wrapped-recap',
    title: 'Year in review',
    appliesTo: embeds('wrapped'),
    render: renderWrappedPanel,
  },
  {
    id: 'summary',
    title: 'This month and the past year',
    appliesTo: embeds('summary'),
    render: renderSummaryPanel,
  },
  {
    id: 'trends',
    title: 'The trend',
    appliesTo: embeds('trends'),
    render: renderTrendsPanel,
  },
  {
    id: 'compare',
    title: 'Current against baseline',
    appliesTo: embeds('compare'),
    render: renderComparePanel,
  },
  {
    id: 'efficiency',
    title: 'Cost against commits',
    appliesTo: embeds('efficiency'),
    render: renderEfficiencyPanel,
  },
  {
    id: 'optimize',
    title: 'Candidate models',
    appliesTo: embeds('optimize'),
    render: renderOptimizePanel,
  },
];
