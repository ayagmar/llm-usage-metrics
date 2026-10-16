// Lays out the panel views: facts, tables, the recap's calendar and top lists. Every figure,
// label and position comes from the models; this file only builds elements.

import type { ShareViewContext } from '../state/context.js';
import { h, s } from '../shell/dom.js';
import { buildCompareView } from './compare-model.js';
import { buildEfficiencyView } from './efficiency-model.js';
import type { PanelFact, PanelTable, PanelView } from './model.js';
import { buildOptimizeView } from './optimize-model.js';
import {
  buildWrappedView,
  type CalendarView,
  type TopList,
  type WrappedView,
} from './wrapped-model.js';

function renderFacts(facts: PanelFact[]): HTMLElement {
  return h(
    'dl',
    { class: 'panel-facts' },
    facts.map((fact) =>
      h('div', { class: 'panel-fact' }, [
        h('dt', { text: fact.label }),
        h('dd', { class: 'panel-fact-value', text: fact.value }),
        fact.detail !== undefined && h('dd', { class: 'panel-fact-detail', text: fact.detail }),
      ]),
    ),
  );
}

function renderTable(table: PanelTable): HTMLElement {
  const row = (cells: PanelTable['rows'][number]) =>
    h(
      'tr',
      {},
      cells.map((cell, index) =>
        h(index === 0 ? 'th' : 'td', {
          class: table.columns[index]?.numeric ? 'num' : undefined,
          attrs: { scope: index === 0 ? 'row' : undefined, title: cell.note },
          text: cell.text,
        }),
      ),
    );

  return h('div', { class: 'panel-table' }, [
    h('h3', { text: table.title }),
    h('div', { class: 'table-scroll' }, [
      h('table', {}, [
        h('thead', {}, [
          h(
            'tr',
            {},
            table.columns.map((column) =>
              h('th', {
                class: column.numeric ? 'num' : undefined,
                attrs: { scope: 'col' },
                text: column.label,
              }),
            ),
          ),
        ]),
        h('tbody', {}, table.rows.map(row)),
        table.foot.length > 0 && h('tfoot', {}, table.foot.map(row)),
      ]),
    ]),
  ]);
}

function renderNote(text: string): HTMLElement {
  return h('p', { class: 'panel-note', text });
}

/** A section panel: its headline facts, its tables, and where the figures come from. */
function renderPanelView(body: HTMLElement, view: PanelView | undefined, command: string) {
  if (!view) {
    body.replaceChildren(
      renderNote(`The ${command} data embedded in this file cannot be read, so it is not shown.`),
    );
    return;
  }

  body.replaceChildren(
    ...(view.facts.length > 0 ? [renderFacts(view.facts)] : []),
    ...view.tables.map(renderTable),
    renderNote(view.note),
  );
}

// The calendar grid, in SVG user units.
const CELL = 11;
const PITCH = 14;
const GUTTER = 30;
const HEAD = 16;

function renderCalendar(calendar: CalendarView): SVGSVGElement {
  const width = GUTTER + calendar.weeks * PITCH;
  const height = HEAD + 7 * PITCH;

  return s(
    'svg',
    {
      class: 'recap-calendar',
      attrs: {
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': calendar.summary,
      },
    },
    [
      ...calendar.months.map((month) =>
        s('text', {
          class: 'calendar-label',
          attrs: { x: GUTTER + month.week * PITCH, y: HEAD - 5 },
          text: month.label,
        }),
      ),
      // Monday, Wednesday and Friday name their rows; all seven would crowd the gutter.
      ...[0, 2, 4].map((weekday) =>
        s('text', {
          class: 'calendar-label',
          attrs: { x: 0, y: HEAD + weekday * PITCH + CELL - 2 },
          text: calendar.weekdays[weekday],
        }),
      ),
      ...calendar.days.map((day) =>
        s(
          'rect',
          {
            class: `heat heat-${day.level}`,
            attrs: {
              x: GUTTER + day.week * PITCH,
              y: HEAD + day.weekday * PITCH,
              width: CELL,
              height: CELL,
              rx: 2,
            },
          },
          [s('title', { text: day.label })],
        ),
      ),
    ],
  );
}

function renderLegend(): HTMLElement {
  return h('p', { class: 'calendar-legend', attrs: { 'aria-hidden': 'true' } }, [
    'Less',
    s(
      'svg',
      { attrs: { viewBox: `0 0 ${5 * PITCH - (PITCH - CELL)} ${CELL}` } },
      [0, 1, 2, 3, 4].map((level) =>
        s('rect', {
          class: `heat heat-${level}`,
          attrs: { x: level * PITCH, y: 0, width: CELL, height: CELL, rx: 2 },
        }),
      ),
    ),
    'More',
  ]);
}

function renderTopList(list: TopList): HTMLElement {
  return h('div', { class: 'top-list' }, [
    h('h3', { text: list.title }),
    h(
      'ol',
      {},
      list.items.map((item) =>
        h('li', {}, [
          h('span', { class: 'top-rank', text: String(item.rank) }),
          h('span', { class: 'top-name', attrs: { title: item.name }, text: item.name }),
          h('span', { class: 'top-figures' }, [
            h('span', { class: 'top-cost', attrs: { title: item.costNote }, text: item.cost }),
            h('span', {
              class: 'top-tokens',
              attrs: { title: item.tokensExact },
              text: `${item.tokens} tokens`,
            }),
          ]),
          s(
            'svg',
            {
              class: 'top-bar',
              attrs: { viewBox: '0 0 100 4', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
            },
            [
              s('rect', { class: 'top-bar-track', attrs: { width: 100, height: 4 } }),
              s('rect', {
                class: 'top-bar-fill',
                attrs: { width: Math.max(item.share * 100, 0.5), height: 4 },
              }),
            ],
          ),
        ]),
      ),
    ),
  ]);
}

/** The wrapped recap: the lede, the year's facts, the calendar and the top lists. */
function renderWrappedView(body: HTMLElement, view: WrappedView | undefined) {
  if (!view) {
    renderPanelView(body, undefined, 'wrapped');
    return;
  }

  body.replaceChildren(
    h(
      'p',
      { class: 'recap-lede' },
      view.lede.map((part) =>
        part.figure ? h('strong', { class: 'recap-figure', text: part.text }) : part.text,
      ),
    ),
    renderFacts(view.facts),
    h('div', { class: 'recap-year' }, [
      h('div', { class: 'recap-calendar-scroll' }, [renderCalendar(view.calendar)]),
      renderLegend(),
    ]),
    h('div', { class: 'recap-lists' }, [
      ...view.topLists.map(renderTopList),
      h('div', { class: 'recap-months' }, [renderTable(view.months)]),
    ]),
    renderNote(view.note),
  );
}

export function renderWrappedPanel(body: HTMLElement, context: ShareViewContext): void {
  renderWrappedView(body, buildWrappedView(context.report));
}

export function renderComparePanel(body: HTMLElement, context: ShareViewContext): void {
  renderPanelView(body, buildCompareView(context.report, context.labels), 'compare');
}

export function renderEfficiencyPanel(body: HTMLElement, context: ShareViewContext): void {
  renderPanelView(body, buildEfficiencyView(context.report), 'efficiency');
}

export function renderOptimizePanel(body: HTMLElement, context: ShareViewContext): void {
  renderPanelView(body, buildOptimizeView(context.report), 'optimize');
}
