// Chart export without the page: a standalone SVG whose look survives outside it. Classes, CSS
// variables and `style` mean nothing in a downloaded file, so every element carries its
// computed colours and font as presentation attributes instead (decision 20). Pure: the
// browser side reads the live tree into {@link ExportNode}s.

import { escapeHtml } from './share-document.js';

/** The SVG namespace: an identifier that is never fetched, not a link. */
export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** An element of the chart as the browser computed it. */
export type ExportNode = {
  /** The tag name as the DOM reports it (`text`, `linearGradient`). */
  tag: string;
  /** Its own attributes, as written. */
  attributes: readonly (readonly [string, string])[];
  /** The computed value of each {@link EXPORT_STYLE_PROPERTIES} entry, by CSS property name. */
  computed: Readonly<Partial<Record<string, string>>>;
  /** Child elements and text, in order. */
  children: readonly (ExportNode | string)[];
};

/** Computed properties written back as presentation attributes. */
export const EXPORT_STYLE_PROPERTIES = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
] as const;

// Paint and font properties only mean something on these; on a group they would be
// inherited values the children already carry.
const TEXT_TAGS = new Set(['text', 'tspan', 'textpath']);
const SHAPE_TAGS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);
const TEXT_PROPERTIES = new Set([
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
]);

// Values that equal the SVG initial value add nothing to the file.
const INITIAL_VALUES: Readonly<Record<string, string>> = {
  'fill-opacity': '1',
  'stroke-opacity': '1',
  opacity: '1',
  stroke: 'none',
  'stroke-width': '1px',
  'stroke-dasharray': 'none',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'font-style': 'normal',
  'text-anchor': 'start',
  'dominant-baseline': 'auto',
  'letter-spacing': 'normal',
};

/** Attributes the page uses for styling or behaviour, which mean nothing in the file. */
function isDroppedAttribute(name: string, value: string): boolean {
  return (
    name === 'class' ||
    name === 'style' ||
    name === 'tabindex' ||
    name.startsWith('on') ||
    name.startsWith('data-') ||
    name.startsWith('aria-') ||
    name === 'role' ||
    name === 'xmlns' ||
    value.includes('var(')
  );
}

function isPainted(tag: string): boolean {
  return isText(tag) || SHAPE_TAGS.has(tag);
}

function isText(tag: string): boolean {
  return TEXT_TAGS.has(tag.toLowerCase());
}

function presentationAttributes(node: ExportNode): [string, string][] {
  if (!isPainted(node.tag)) {
    return [];
  }

  return EXPORT_STYLE_PROPERTIES.flatMap((property): [string, string][] => {
    const value = node.computed[property];

    return value === undefined ||
      value === '' ||
      value.includes('var(') ||
      INITIAL_VALUES[property] === value ||
      (TEXT_PROPERTIES.has(property) && !isText(node.tag))
      ? []
      : [[property, value]];
  });
}

/**
 * The node's own attributes that still mean something in the file. On a painted element the
 * computed values replace its presentation attributes, since CSS wins over them on the page.
 */
function ownAttributes(node: ExportNode): (readonly [string, string])[] {
  const replaced: ReadonlySet<string> = isPainted(node.tag)
    ? new Set(EXPORT_STYLE_PROPERTIES)
    : new Set();

  return node.attributes.filter(
    ([name, value]) => !isDroppedAttribute(name, value) && !replaced.has(name),
  );
}

function renderAttributes(attributes: readonly (readonly [string, string])[]): string {
  return attributes.map(([name, value]) => ` ${name}="${escapeHtml(value)}"`).join('');
}

/** True when the browser does not draw the node, so the export leaves it out. */
function isHidden(node: ExportNode): boolean {
  return node.computed.display === 'none' || node.computed.visibility === 'hidden';
}

function renderNode(node: ExportNode): string {
  if (isHidden(node)) {
    return '';
  }

  const attributes = [...ownAttributes(node), ...presentationAttributes(node)];
  const children = node.children
    .map((child) => (typeof child === 'string' ? escapeHtml(child) : renderNode(child)))
    .join('');

  return children === ''
    ? `<${node.tag}${renderAttributes(attributes)}/>`
    : `<${node.tag}${renderAttributes(attributes)}>${children}</${node.tag}>`;
}

/** The pixel size of an SVG: its width and height attributes, else its viewBox. */
export function getSvgSize(node: ExportNode): { width: number; height: number } | undefined {
  const attribute = (name: string) => node.attributes.find(([key]) => key === name)?.[1];
  const width = Number.parseFloat(attribute('width') ?? '');
  const height = Number.parseFloat(attribute('height') ?? '');

  if (width > 0 && height > 0) {
    return { width, height };
  }

  const viewBox = (attribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/u)
    .map(Number);

  return viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0
    ? { width: viewBox[2], height: viewBox[3] }
    : undefined;
}

/**
 * A standalone SVG file of a chart: namespaced, sized, on the page's background colour, with
 * computed styling as attributes and no class, CSS variable or `style` left.
 */
export function serializeSvgForExport(root: ExportNode, background: string): string {
  const size = getSvgSize(root);
  const sizeAttributes: [string, string][] = size
    ? [
        ['width', String(size.width)],
        ['height', String(size.height)],
      ]
    : [];
  const attributes = [
    ['xmlns', SVG_NAMESPACE] as const,
    ...sizeAttributes,
    ...root.attributes.filter(
      ([name, value]) => name !== 'width' && name !== 'height' && !isDroppedAttribute(name, value),
    ),
  ];
  const backdrop =
    background === '' || background.includes('var(')
      ? ''
      : `<rect width="100%" height="100%" fill="${escapeHtml(background)}"/>`;
  const children = root.children
    .map((child) => (typeof child === 'string' ? escapeHtml(child) : renderNode(child)))
    .join('');

  return `<svg${renderAttributes(attributes)}>${backdrop}${children}</svg>`;
}

/** `usage-daily-share-cost-over-time-dark.png`: the file, the chart and the theme it shows. */
export function getExportFileName(
  fileBaseName: string,
  chartId: string,
  theme: 'light' | 'dark',
  extension: 'png' | 'svg',
): string {
  return `${fileBaseName}-${chartId}-${theme}.${extension}`;
}

/** The canvas size for a PNG: twice the SVG size for sharp text, capped to what browsers draw. */
export function getRasterSize(
  size: { width: number; height: number },
  scale = 2,
  maxSide = 8192,
): { width: number; height: number } {
  const factor = Math.min(scale, maxSide / size.width, maxSide / size.height);

  return {
    width: Math.max(1, Math.round(size.width * factor)),
    height: Math.max(1, Math.round(size.height * factor)),
  };
}
