// Lays out a table view: sortable headers, rows, totals, the pager and the drill-down crumbs.

import type { TableSortKey } from '../../core/index.js';
import { h } from '../shell/dom.js';
import {
  describeOmittedSessions,
  describePage,
  type CellView,
  type ColumnView,
  type TableView,
} from './model.js';

export type TableActions = {
  sort: (key: TableSortKey) => void;
  drill: (project: number | null) => void;
  page: (page: number) => void;
};

/** `num` right-aligns a measure; `wide-only` hides a breakdown column on narrow screens. */
function columnClass(column: ColumnView | undefined): string | undefined {
  const names = [column?.numeric && 'num', column?.narrow === false && 'wide-only'].filter(Boolean);
  return names.length > 0 ? names.join(' ') : undefined;
}

function cell(
  tag: 'td' | 'th',
  view: CellView,
  column: ColumnView | undefined,
  scope?: string,
): HTMLElement {
  return h(tag, {
    class: columnClass(column),
    attrs: { title: view.note, scope },
    text: view.text,
  });
}

function header(table: TableView, actions: TableActions): HTMLElement {
  return h('thead', {}, [
    h(
      'tr',
      {},
      table.columns.map((column) => {
        const th = h('th', {
          class: columnClass(column),
          attrs: { scope: 'col', 'aria-sort': column.sortKey ? column.sort : undefined },
        });
        const key = column.sortKey;

        if (key === undefined) {
          th.textContent = column.label;
          return th;
        }

        const button = h('button', {
          class: 'sort',
          attrs: { type: 'button', 'data-focus': `sort-${table.kind}-${key}` },
          text: column.label,
        });
        button.addEventListener('click', () => {
          actions.sort(key);
        });
        th.append(button);
        return th;
      }),
    ),
  ]);
}

function body(table: TableView, actions: TableActions): HTMLElement {
  return h(
    'tbody',
    {},
    table.rows.map((row) =>
      h(
        'tr',
        {},
        row.cells.map((view, index) => {
          const column = table.columns[index];

          if (index > 0) {
            return cell('td', view, column);
          }

          const th = cell('th', row.drill === undefined ? view : { text: '' }, column, 'row');
          const drill = row.drill;

          if (drill !== undefined) {
            const button = h('button', {
              class: 'drill',
              attrs: { type: 'button', 'data-focus': `drill-${drill}`, title: 'Show its sessions' },
              text: view.text,
            });
            button.addEventListener('click', () => {
              actions.drill(drill);
            });
            th.append(button);
          }

          return th;
        }),
      ),
    ),
  );
}

function pager(table: TableView, actions: TableActions): HTMLElement | undefined {
  if (table.pageCount <= 1) {
    return undefined;
  }

  const button = (label: string, page: number, disabled: boolean, focus: string) => {
    const element = h('button', {
      class: 'chip',
      attrs: { type: 'button', disabled, 'data-focus': `${table.kind}-${focus}` },
      text: label,
    });
    element.addEventListener('click', () => {
      actions.page(page);
    });
    return element;
  };

  return h('nav', { class: 'pager', attrs: { 'aria-label': `${table.caption} pages` } }, [
    button('Previous', table.page - 1, table.page === 0, 'previous'),
    h('span', {
      class: 'pager-status',
      text: `${describePage(table)} · page ${table.page + 1} of ${table.pageCount}`,
    }),
    button('Next', table.page + 1, table.page >= table.pageCount - 1, 'next'),
  ]);
}

export function renderTable(table: TableView, actions: TableActions): HTMLElement[] {
  const heading =
    table.kind === 'projects'
      ? h('h2', { attrs: { id: 'table-heading' }, text: 'Projects' })
      : h('div', { class: 'crumbs' }, [
          (() => {
            const back = h('button', {
              class: 'link-button',
              attrs: { type: 'button', 'data-focus': 'drill-back' },
              text: '← All projects',
            });
            back.addEventListener('click', () => {
              actions.drill(null);
            });
            return back;
          })(),
          h('h2', { attrs: { id: 'table-heading' }, text: table.caption }),
        ]);

  const omitted = describeOmittedSessions(table.omittedSessions);
  const parts: (HTMLElement | undefined)[] = [heading];

  if (table.rows.length === 0) {
    parts.push(h('p', { class: 'empty-note', text: table.empty }));
  } else {
    parts.push(
      h(
        'div',
        {
          class: 'table-scroll',
          attrs: { tabindex: 0, role: 'region', 'aria-labelledby': 'table-heading' },
        },
        [
          h('table', {}, [
            h('caption', {
              class: 'visually-hidden',
              text: `${table.caption}, sortable by column`,
            }),
            header(table, actions),
            body(table, actions),
            table.total
              ? h('tfoot', {}, [
                  h(
                    'tr',
                    {},
                    table.total.map((view, index) =>
                      index === 0
                        ? cell('th', view, table.columns[index], 'row')
                        : cell('td', view, table.columns[index]),
                    ),
                  ),
                ])
              : undefined,
          ]),
        ],
      ),
      pager(table, actions),
    );
  }

  if (omitted) {
    parts.push(h('p', { class: 'note', text: omitted }));
  }

  return parts.filter((part): part is HTMLElement => part !== undefined);
}
