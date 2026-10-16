// Lays out the shell's pieces from their models: header, summary row, empty state, the frames
// charts and panels draw into, and the page shown when the payload cannot be read.

import { h } from './dom.js';
import type { EmptyState, HeaderView, SummaryFigure } from './model.js';

export function renderHeaderContent(header: HeaderView): HTMLElement[] {
  return [
    h('div', { class: 'title-block' }, [
      h('h1', { text: header.title }),
      h('p', { class: 'period', attrs: { 'aria-live': 'polite' }, text: header.period }),
    ]),
    h(
      'ul',
      { class: 'facts' },
      header.facts.map((fact) => h('li', { text: fact })),
    ),
    h(
      'ul',
      { class: 'badges', attrs: { 'aria-label': 'About this file' } },
      header.badges.map((badge) =>
        h('li', { class: `badge badge-${badge.tone}`, text: badge.text }),
      ),
    ),
  ];
}

export function renderSummary(figures: SummaryFigure[]): HTMLElement {
  return h(
    'dl',
    { class: 'summary' },
    figures.map((figure) =>
      h('div', { class: 'figure', attrs: { 'data-figure': figure.id } }, [
        h('dt', { text: figure.label }),
        h('dd', { class: 'figure-value', text: figure.value }),
        h('dd', { class: 'figure-detail', text: figure.detail }),
      ]),
    ),
  );
}

export function renderEmptyState(
  empty: EmptyState,
  actions: { resetFilters: () => void; resetView: () => void },
): HTMLElement {
  let action: HTMLElement | undefined;

  if (empty.action) {
    const button = h('button', {
      class: 'button',
      attrs: { type: 'button', 'data-focus': `empty-${empty.action}` },
      text: empty.action === 'reset-filters' ? 'Clear filters' : 'Back to the opening view',
    });
    button.addEventListener(
      'click',
      empty.action === 'reset-filters' ? actions.resetFilters : actions.resetView,
    );
    action = button;
  }

  return h('div', { class: 'empty', attrs: { role: 'status' } }, [
    h('h2', { text: empty.title }),
    h('p', { text: empty.body }),
    action,
  ]);
}

export type ExportActions = {
  png: () => void;
  svg: () => void;
  copy: (() => void) | undefined;
};

/** A chart's frame: its title, export buttons and the body the chart draws into. */
export function renderChartFrame(
  id: string,
  title: string,
  actions: ExportActions,
): { element: HTMLElement; body: HTMLElement } {
  const button = (label: string, name: string, onClick: () => void) => {
    const element = h('button', {
      class: 'chip',
      attrs: {
        type: 'button',
        'data-focus': `chart-${id}-${name}`,
        'aria-label': `${label}: ${title}`,
      },
      text: label,
    });
    element.addEventListener('click', onClick);
    return element;
  };
  const body = h('div', { class: 'chart-body' });
  const element = h(
    'figure',
    { class: 'chart', attrs: { id: `chart-${id}`, 'aria-labelledby': `chart-${id}-title` } },
    [
      h('figcaption', { class: 'chart-head' }, [
        h('h3', { attrs: { id: `chart-${id}-title` }, text: title }),
        h(
          'div',
          { class: 'chart-actions', attrs: { role: 'group', 'aria-label': `Export ${title}` } },
          [
            button('PNG', 'png', actions.png),
            button('SVG', 'svg', actions.svg),
            actions.copy && button('Copy image', 'copy', actions.copy),
          ],
        ),
      ]),
      body,
    ],
  );

  return { element, body };
}

/** A panel's frame: its heading and the body the panel draws into. */
export function renderPanelFrame(
  id: string,
  title: string,
): { element: HTMLElement; body: HTMLElement } {
  const body = h('div', { class: 'panel-body' });
  const element = h(
    'section',
    { class: 'panel', attrs: { id: `panel-${id}`, 'aria-labelledby': `panel-${id}-title` } },
    [h('h2', { attrs: { id: `panel-${id}-title` }, text: title }), body],
  );

  return { element, body };
}

/** The whole page when the embedded payload is missing or malformed. */
export function renderFailure(error: string): HTMLElement {
  return h('main', { class: 'page failure' }, [
    h('div', { class: 'empty', attrs: { role: 'alert' } }, [
      h('h1', { text: 'This report cannot be read' }),
      h('p', {
        text: 'The data embedded in this file is missing or damaged, so there is nothing to draw. Generate the report again with --share.',
      }),
      h('p', { class: 'failure-detail', text: `Detail: ${error}` }),
    ]),
  ]);
}
