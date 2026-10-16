// DOM glue for charts: draws a chart model into its frame's body at the body's width, again when
// that width changes, and lays out the notes and the table equivalent. The models decide
// everything; this only measures and builds elements.

import { SVG_NAMESPACE } from '../export/svg-export.js';
import { h } from '../shell/dom.js';
import type { ShareViewContext } from '../state/context.js';
import type { ChartTable, ChartView, SvgNode } from './svg.js';

export type ChartBuilder = (context: ShareViewContext, width: number) => ChartView;

type Mounted = { context: ShareViewContext; build: ChartBuilder; width: number };

// The width a hidden body (the page's empty state) is drawn at until it shows.
const FALLBACK_WIDTH = 640;

const mounted = new WeakMap<HTMLElement, Mounted>();

function measure(body: HTMLElement): number {
  const width = Math.floor(body.clientWidth);
  return width > 0 ? width : FALLBACK_WIDTH;
}

function toElement(node: SvgNode): SVGElement {
  const element = document.createElementNS(SVG_NAMESPACE, node.tag);

  for (const [name, value] of Object.entries(node.attrs)) {
    element.setAttribute(name, String(value));
  }

  for (const child of node.children) {
    element.append(typeof child === 'string' ? child : toElement(child));
  }

  return element;
}

function renderTable(table: ChartTable): HTMLElement {
  const cell = (tag: 'th' | 'td', content: string, numeric: boolean, scope?: string) =>
    h(tag, { class: numeric ? 'num' : undefined, attrs: { scope }, text: content });

  return h('div', { class: 'table-scroll' }, [
    h('table', {}, [
      h('caption', { class: 'chart-table-caption', text: table.caption }),
      h('thead', {}, [
        h(
          'tr',
          {},
          table.columns.map((column) => cell('th', column.label, column.numeric, 'col')),
        ),
      ]),
      h(
        'tbody',
        {},
        table.rows.map((row) =>
          h(
            'tr',
            {},
            row.map((content, index) =>
              index === 0
                ? cell('th', content, false, 'row')
                : cell('td', content, table.columns[index]?.numeric ?? false),
            ),
          ),
        ),
      ),
      table.total &&
        h('tfoot', {}, [
          h(
            'tr',
            {},
            table.total.map((content, index) =>
              index === 0
                ? cell('th', content, false, 'row')
                : cell('td', content, table.columns[index]?.numeric ?? false),
            ),
          ),
        ]),
    ]),
  ]);
}

/** The table equivalent, built when first opened: a long one costs nothing until asked for. */
function renderTableToggle(table: ChartTable, open: boolean, focusKey: string): HTMLElement {
  const details = h('details', { class: 'chart-table', attrs: { open } }, [
    h('summary', {
      attrs: { 'data-focus': focusKey },
      text: `Show as a table (${table.rows.length} ${table.rows.length === 1 ? 'row' : 'rows'})`,
    }),
  ]);
  const fill = () => {
    if (details.open && details.childElementCount === 1) {
      details.append(renderTable(table));
    }
  };
  details.addEventListener('toggle', fill);
  fill();
  return details;
}

function draw(body: HTMLElement, state: Mounted): void {
  state.width = measure(body);
  const view = state.build(state.context, state.width);
  const open = body.querySelector('details')?.open ?? false;
  const focusKey = `${body.parentElement?.id ?? 'chart'}-table`;

  const svg = view.svg && toElement(view.svg);
  svg?.setAttribute('aria-label', view.description);

  body.replaceChildren(
    ...[
      svg,
      view.message !== undefined &&
        h('p', { class: 'chart-message', attrs: { role: 'note' }, text: view.message }),
      view.notes.length > 0 &&
        h(
          'ul',
          { class: 'chart-notes' },
          view.notes.map((note) => h('li', { text: note })),
        ),
      view.table && renderTableToggle(view.table, open, focusKey),
    ].filter((child) => child !== undefined && child !== false),
  );
}

/** A chart slot's `render`: draws `build`'s chart into the body at its width. */
export function chartRenderer(
  build: ChartBuilder,
): (body: HTMLElement, context: ShareViewContext) => void {
  return (body, context) => {
    mountChart(body, context, build);
  };
}

/** Draws `build`'s chart into `body` for this view, and keeps it drawn at the body's width. */
function mountChart(body: HTMLElement, context: ShareViewContext, build: ChartBuilder): void {
  let state = mounted.get(body);

  if (!state) {
    const created: Mounted = { context, build, width: 0 };
    state = created;
    mounted.set(body, created);
    let frame = 0;
    // Redraw on the next frame, not inside the callback: a redraw that changes the page height
    // can toggle the scrollbar and resize the body again, which the browser reports as an error.
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (measure(body) !== created.width) {
          draw(body, created);
        }
      });
    }).observe(body);
  }

  state.context = context;
  state.build = build;
  draw(body, state);
}
