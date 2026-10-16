// The charts in page order, as pure models: what each draws from a view at a width. The
// registry (`index.ts`) mounts them; Node tests run them directly.

import type { ShareViewContext } from '../state/context.js';
import { buildModelMixChart, buildProjectChart } from './breakdown.js';
import { buildBlockChart, buildHourWeekdayChart } from './heatmaps.js';
import { buildOverTimeChart } from './over-time.js';
import { buildCacheHitChart, buildCostPerHourChart } from './rates.js';
import type { ChartView } from './svg.js';

export type ChartModel = {
  /** Stable and URL-safe: the figure id, export file names and hatch pattern ids. */
  id: string;
  title: string;
  build: (context: ShareViewContext, width: number) => ChartView;
};

export const CHART_MODELS: readonly ChartModel[] = [
  {
    id: 'cost-over-time',
    title: 'Cost over time',
    build: (context, width) => buildOverTimeChart('cost-over-time', 'cost', context, width),
  },
  {
    id: 'tokens-over-time',
    title: 'Tokens over time',
    build: (context, width) => buildOverTimeChart('tokens-over-time', 'tokens', context, width),
  },
  {
    id: 'projects',
    title: 'Projects',
    build: (context, width) => buildProjectChart('projects', context, width),
  },
  {
    id: 'model-mix',
    title: 'Model mix',
    build: (context, width) => buildModelMixChart('model-mix', context, width),
  },
  { id: 'cache-hit-rate', title: 'Cache hit rate', build: buildCacheHitChart },
  { id: 'cost-per-active-hour', title: 'Cost per active hour', build: buildCostPerHourChart },
  { id: 'hour-weekday', title: 'Hour of day by weekday', build: buildHourWeekdayChart },
  { id: 'blocks', title: '5-hour blocks', build: buildBlockChart },
];
