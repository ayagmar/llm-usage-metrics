// Lays out the leads: ledes, facts, tables, the calendars, the trend chart and the recap's top
// lists. Every figure, label and position comes from the models; this file only builds
// elements.

import type { ShareViewContext } from '../state/context.js';
import { h, s } from '../shell/dom.js';
import { pluralize } from '../shell/format.js';
import { buildCompareView } from './compare-model.js';
import { buildEfficiencyView } from './efficiency-model.js';
import type { CalendarView } from './calendar-model.js';
import type { LedePart, PanelColumn, PanelFact, PanelTable, PanelView } from './model.js';
import { buildOptimizeView } from './optimize-model.js';
import { buildSummaryView, type SummaryView } from './summary-model.js';
import { buildTrendsView, type TrendChart, type TrendsView } from './trends-model.js';
import { buildWrappedView, type TopList, type WrappedView } from './wrapped-model.js';

type Part = Node | false | undefined;

/** Replaces `body`'s content with the parts that are present. */
function fill(body: HTMLElement, parts: Part[]): void {
  body.replaceChildren(...parts.filter((part): part is Node => part instanceof Node));
}

function renderLede(parts: LedePart[]): HTMLElement | false {
  return (
    parts.length > 0 &&
    h(
      'p',
      { class: 'lede' },
      parts.map((part) =>
        part.figure ? h('strong', { class: 'lede-figure', text: part.text }) : part.text,
      ),
    )
  );
}

function renderFacts(facts: PanelFact[], label?: string): HTMLElement {
  return h(
    'dl',
    { class: 'panel-facts', attrs: { 'aria-label': label } },
    facts.map((fact) =>
      h('div', { class: 'panel-fact' }, [
        h('dt', { text: fact.label }),
        h('dd', { class: 'panel-fact-value', text: fact.value }),
        fact.detail !== undefined && h('dd', { class: 'panel-fact-detail', text: fact.detail }),
      ]),
    ),
  );
}

/** `num` right-aligns a measure; `wide-only` hides a secondary column on narrow screens. */
function columnClass(column: PanelColumn | undefined): string | undefined {
  const names = [column?.numeric && 'num', column?.narrow === false && 'wide-only'].filter(Boolean);
  return names.length > 0 ? names.join(' ') : undefined;
}

function renderTable(table: PanelTable): HTMLElement {
  const row = (cells: PanelTable['rows'][number]) =>
    h(
      'tr',
      {},
      cells.map((cell, index) =>
        h(index === 0 ? 'th' : 'td', {
          class: columnClass(table.columns[index]),
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
                class: columnClass(column),
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

/**
 * A chart's table equivalent behind "Show as a table"; `open` keeps it as the reader left it
 * when the panel draws again.
 */
function renderChartTable(table: PanelTable, focus: string, open: boolean): HTMLElement {
  return h('details', { class: 'chart-table', attrs: { open } }, [
    h('summary', {
      attrs: { 'data-focus': focus },
      text: `Show as a table (${pluralize(table.rows.length, 'day')} with usage)`,
    }),
    renderTable(table),
  ]);
}

function renderNote(text: string): HTMLElement {
  return h('p', { class: 'panel-note', text });
}

/** A lead from a command's envelope: its sentence, facts, tables and where they come from. */
function renderPanelView(body: HTMLElement, view: PanelView | undefined, command: string) {
  if (!view) {
    body.replaceChildren(
      renderNote(`The ${command} data embedded in this file cannot be read, so it is not shown.`),
    );
    return;
  }

  fill(body, [
    renderLede(view.lede),
    view.facts.length > 0 && renderFacts(view.facts),
    ...view.tables.map(renderTable),
    renderNote(view.note),
  ]);
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
        // Drawn at most half again its natural size, so a short year does not blow up.
        width: Math.round(width * 1.5),
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

function renderYear(calendar: CalendarView): HTMLElement {
  return h('div', { class: 'recap-year' }, [
    h('div', { class: 'recap-calendar-scroll' }, [renderCalendar(calendar)]),
    renderLegend(),
  ]);
}

/** The wrapped recap: the lede, the year's facts, the calendar and the top lists. */
function renderWrappedView(body: HTMLElement, view: WrappedView | undefined) {
  if (!view) {
    renderPanelView(body, undefined, 'wrapped');
    return;
  }

  fill(body, [
    renderLede(view.lede),
    renderFacts(view.facts),
    renderYear(view.calendar),
    h('div', { class: 'recap-lists' }, [
      ...view.topLists.map(renderTopList),
      h('div', { class: 'recap-months' }, [renderTable(view.months)]),
    ]),
    renderNote(view.note),
  ]);
}

/** The summary lead: the month in a sentence, its notes, the periods, then the past year. */
function renderSummaryView(body: HTMLElement, view: SummaryView | undefined) {
  if (!view) {
    renderPanelView(body, undefined, 'summary');
    return;
  }

  const open = body.querySelector('details')?.open ?? false;

  fill(body, [
    renderLede(view.lede),
    view.month.length > 0 && renderFacts(view.month, 'This month'),
    h('div', { class: 'lead-tables' }, view.tables.map(renderTable)),
    h('div', { class: 'lead-year' }, [
      h('h3', { text: 'Past year' }),
      renderFacts(view.activity, 'Past year'),
      renderYear(view.calendar),
      view.calendar.table.rows.length > 0 &&
        renderChartTable(view.calendar.table, 'summary-days', open),
    ]),
    renderNote(view.note),
  ]);

  // On a narrow screen the calendar scrolls; open it on the latest weeks.
  const scroll = body.querySelector('.recap-calendar-scroll');

  if (scroll) {
    scroll.scrollLeft = scroll.scrollWidth;
  }
}

function renderTrendChart(chart: TrendChart): SVGSVGElement {
  return s(
    'svg',
    {
      class: 'trend-chart',
      attrs: {
        viewBox: `0 0 ${chart.width} ${chart.height}`,
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': chart.summary,
      },
    },
    [
      ...chart.bars.map((bar) =>
        s(
          'rect',
          {
            class: bar.peak ? 'trend-bar trend-bar-peak' : 'trend-bar',
            attrs: { x: bar.x, y: bar.y, width: bar.width, height: bar.height },
          },
          [s('title', { text: bar.label })],
        ),
      ),
      s('line', {
        class: 'trend-average',
        attrs: {
          x1: 0,
          x2: chart.width,
          y1: chart.average.y,
          y2: chart.average.y,
          'vector-effect': 'non-scaling-stroke',
        },
      }),
    ],
  );
}

/** What the marks mean, in words beside a sample of each. */
function renderTrendLegend(chart: TrendChart): HTMLElement {
  const sample = (className: string) =>
    s('svg', { class: 'trend-key', attrs: { viewBox: '0 0 12 12', 'aria-hidden': 'true' } }, [
      className === 'trend-average'
        ? s('line', { class: className, attrs: { x1: 0, x2: 12, y1: 6, y2: 6 } })
        : s('rect', { class: className, attrs: { width: 12, height: 12, rx: 2 } }),
    ]);

  return h('ul', { class: 'trend-legend' }, [
    h('li', {}, [sample('trend-bar-peak'), chart.peak]),
    h('li', {}, [sample('trend-average'), chart.average.label]),
  ]);
}

/** The trends lead: the sentence, the series with its peak and average, the split totals. */
function renderTrendsView(body: HTMLElement, view: TrendsView | undefined) {
  if (!view) {
    renderPanelView(body, undefined, 'trends');
    return;
  }

  const open = body.querySelector('details')?.open ?? false;

  fill(body, [
    renderLede(view.lede),
    view.chart &&
      h('figure', { class: 'trend' }, [
        h('figcaption', {}, [h('h3', { text: view.title }), renderTrendLegend(view.chart)]),
        renderTrendChart(view.chart),
        h(
          'div',
          { class: 'trend-dates', attrs: { 'aria-hidden': 'true' } },
          view.chart.dates.map((date) => h('span', { text: date })),
        ),
        renderChartTable(view.days, 'trends-days', open),
      ]),
    ...view.tables.map(renderTable),
    renderNote(view.note),
  ]);
}

export function renderSummaryPanel(body: HTMLElement, context: ShareViewContext): void {
  renderSummaryView(body, buildSummaryView(context.report, context.labels));
}

export function renderTrendsPanel(body: HTMLElement, context: ShareViewContext): void {
  renderTrendsView(body, buildTrendsView(context.report, context.labels));
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
