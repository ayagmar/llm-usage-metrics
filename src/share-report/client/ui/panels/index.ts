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

export type SharePanel = {
  /** Stable and URL-safe: names the section's element id. */
  id: string;
  title: string;
  placement: PanelPlacement;
  appliesTo: (report: ShareReport) => boolean;
  render: (body: HTMLElement, context: ShareViewContext) => void;
};

export const SHARE_PANELS: readonly SharePanel[] = [];
