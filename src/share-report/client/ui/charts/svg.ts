// A chart as plain data: the SVG tree, the words around it and its table equivalent. Every chart
// model returns one of these from the view alone, so Node tests can read the whole drawing;
// `mount.ts` turns it into elements.

/** An SVG element: tag, attributes (no `style`: the CSP forbids it) and children. */
export type SvgNode = {
  tag: string;
  attrs: Readonly<Record<string, string | number>>;
  children: readonly (SvgNode | string)[];
};

/** The table a chart's numbers read as, for screen readers and copy-paste. */
export type ChartTable = {
  caption: string;
  columns: { label: string; numeric: boolean }[];
  /** One text per column. */
  rows: string[][];
  /** A totals row, when the columns add up. */
  total?: string[];
};

export type ChartView = {
  /** What the drawing shows, in a sentence: the SVG's accessible name. */
  description: string;
  /** The drawing; undefined when there is nothing to draw and {@link message} says why. */
  svg?: SvgNode;
  message?: string;
  /** Short lines under the drawing: approximations, clipping, ignored filters. */
  notes: string[];
  table?: ChartTable;
};

export function el(
  tag: string,
  attrs: Record<string, string | number | undefined> = {},
  children: readonly (SvgNode | string | false | undefined)[] = [],
): SvgNode {
  const kept: Record<string, string | number> = {};

  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined) {
      kept[name] = value;
    }
  }

  return {
    tag,
    attrs: kept,
    children: children.filter(
      (child): child is SvgNode | string => child !== false && child !== undefined,
    ),
  };
}

/** A text element; `size` is its font size in px, which label layout also measures with. */
export function text(
  x: number,
  y: number,
  content: string,
  options: { class: string; size: number; anchor?: 'start' | 'middle' | 'end'; title?: string },
): SvgNode {
  return el(
    'text',
    {
      x: round(x),
      y: round(y),
      class: options.class,
      'font-size': options.size,
      'text-anchor': options.anchor === 'start' ? undefined : options.anchor,
    },
    [content],
  );
}

/** A tooltip on the element it is the first child of. */
export function tooltip(content: string): SvgNode {
  return el('title', {}, [content]);
}

/** Two decimals: enough for any screen, and short in the file. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The root `<svg>`: sized by its viewBox in CSS pixels, with an accessible name. */
export function svgRoot(
  width: number,
  height: number,
  label: string,
  children: readonly (SvgNode | false | undefined)[],
): SvgNode {
  return el(
    'svg',
    {
      viewBox: `0 0 ${round(width)} ${round(height)}`,
      class: 'chart-svg',
      role: 'img',
      'aria-label': label,
    },
    children,
  );
}
