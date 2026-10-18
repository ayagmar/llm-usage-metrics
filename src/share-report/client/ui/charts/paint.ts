// How a series is painted: a colour from the `--series-*` tokens and, from the second series on,
// a hatch over it, so series stay apart without colour (decision 22). Hatches are SVG patterns
// whose ids carry the chart id: two charts on one page, or one exported file, never share one.

import { el, round, type SvgNode } from './svg.js';

/** Series with their own colour; the rest merge into `Other`. */
export const SERIES_COLOURS = 8;

type Hatch = { size: number; rotate: number; d: string };

// One per series slot after the first (solid), in order; lines only, so one stroke style draws
// them all.
const HATCHES: readonly Hatch[] = [
  { size: 5, rotate: 45, d: 'M0 0V5' },
  { size: 5, rotate: 0, d: 'M0 2.5H5' },
  { size: 5, rotate: -45, d: 'M0 0V5' },
  { size: 5, rotate: 0, d: 'M2.5 0V5' },
  { size: 6, rotate: 45, d: 'M0 3H6M3 0V6' },
  { size: 6, rotate: 0, d: 'M0 3H6M3 0V6' },
  { size: 8, rotate: 45, d: 'M0 0V8' },
];

export type SeriesPaint = {
  /** `series-3`, `series-other`: the fill class. */
  colourClass: string;
  /** The hatch over the colour, with its pattern id; none for the first series and `Other`. */
  hatch: (Hatch & { id: string }) | undefined;
};

/** The paint of the series at `slot` (0 first); `other` for the merged remainder. */
export function getSeriesPaint(chartId: string, slot: number | 'other'): SeriesPaint {
  if (slot === 'other') {
    return { colourClass: 'series-other', hatch: undefined };
  }

  const position = slot % SERIES_COLOURS;

  return {
    colourClass: `series-${position + 1}`,
    hatch:
      position === 0
        ? undefined
        : { ...HATCHES[position - 1], id: `${chartId}-hatch-${position + 1}` },
  };
}

/** The `<defs>` holding the hatches of `paints`, each once; undefined when none has one. */
export function hatchDefs(paints: readonly SeriesPaint[]): SvgNode | undefined {
  const hatches = new Map(
    paints.flatMap((paint) => (paint.hatch ? [[paint.hatch.id, paint.hatch] as const] : [])),
  );
  const patterns = [...hatches.values()].map((hatch) =>
    el(
      'pattern',
      {
        id: hatch.id,
        patternUnits: 'userSpaceOnUse',
        width: hatch.size,
        height: hatch.size,
        patternTransform: hatch.rotate === 0 ? undefined : `rotate(${hatch.rotate})`,
      },
      [el('path', { class: 'chart-hatch', d: hatch.d })],
    ),
  );

  return patterns.length === 0 ? undefined : el('defs', {}, patterns);
}

/** A painted rectangle: the colour, then its hatch over it. */
export function paintedRect(
  paint: SeriesPaint,
  box: { x: number; y: number; width: number; height: number },
  title?: SvgNode,
): SvgNode {
  const geometry = {
    x: round(box.x),
    y: round(box.y),
    width: round(box.width),
    height: round(box.height),
  };

  if (!paint.hatch) {
    return el('rect', { ...geometry, class: paint.colourClass }, [title]);
  }

  return el('g', {}, [
    title,
    el('rect', { ...geometry, class: paint.colourClass }),
    el('rect', { ...geometry, fill: `url(#${paint.hatch.id})` }),
  ]);
}
