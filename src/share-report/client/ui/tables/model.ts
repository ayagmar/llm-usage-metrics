// The project table and its session drill-down as plain rows of text: what each column
// shows, how it sorts and which page is visible. The DOM side only lays these out.

import type { ShareSession } from '../../../types.js';
import {
  getCacheHitRate,
  getCost,
  getCostAmount,
  getOmittedSessionCount,
  paginate,
  rollupByDimension,
  selectSessions,
  sortRows,
  sumCells,
  type ShareDimensionRow,
  type ShareTotals,
  type SortValue,
  type TableSortKey,
} from '../../core/index.js';
import {
  formatCost,
  formatCount,
  formatDuration,
  formatPercent,
  formatTimestamp,
  pluralize,
} from '../shell/format.js';
import type { ShareViewContext } from '../state/context.js';

export const TABLE_PAGE_SIZE = 20;

export type CellView = { text: string; note?: string };

export type ColumnView = {
  key: TableSortKey | 'source' | 'models' | 'machines';
  label: string;
  numeric: boolean;
  /** The key a header click sorts by; undefined for a text column that does not sort. */
  sortKey: TableSortKey | undefined;
  /**
   * Kept on narrow screens: the label, tokens and cost (events without a cost). The breakdown
   * columns go first, so a phone shows what people open the table for.
   */
  narrow: boolean;
  /** `aria-sort` for the header. */
  sort: 'ascending' | 'descending' | 'none';
};

export type RowView = {
  key: string;
  /** One cell per column; the first is the row's label. */
  cells: CellView[];
  /** The project index to drill into, on project rows. */
  drill?: number;
};

export type TableView = {
  kind: 'projects' | 'sessions';
  caption: string;
  columns: ColumnView[];
  rows: RowView[];
  /** The totals of every row on every page; absent for sessions. */
  total?: CellView[];
  page: number;
  pageCount: number;
  rowCount: number;
  /** Shown instead of rows when there are none. */
  empty: string;
  /** Sessions the file left out (the per-project cap), for a note under the table. */
  omittedSessions: number;
};

type Column<Row> = {
  key: ColumnView['key'];
  label: string;
  numeric: boolean;
  cell: (row: Row) => CellView;
};

type Measured = Pick<
  ShareTotals,
  | 'totalTokens'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'eventCount'
  | 'activeMs'
  | 'costs'
>;

function count(value: number): CellView {
  return { text: formatCount(value) };
}

/** The measure columns both tables share, in reading order; cost only when the file has it. */
function measureColumns<Row extends Measured>(context: ShareViewContext): Column<Row>[] {
  const { report, view } = context;
  const columns: Column<Row>[] = [
    { key: 'totalTokens', label: 'Tokens', numeric: true, cell: (row) => count(row.totalTokens) },
    { key: 'inputTokens', label: 'Input', numeric: true, cell: (row) => count(row.inputTokens) },
    { key: 'outputTokens', label: 'Output', numeric: true, cell: (row) => count(row.outputTokens) },
    {
      key: 'cacheReadTokens',
      label: 'Cache read',
      numeric: true,
      cell: (row) => count(row.cacheReadTokens),
    },
    {
      key: 'cacheHitRate',
      label: 'Cache hit',
      numeric: true,
      cell: (row) => ({ text: formatPercent(getCacheHitRate(row)) }),
    },
    { key: 'eventCount', label: 'Events', numeric: true, cell: (row) => count(row.eventCount) },
    {
      key: 'activeMs',
      label: 'Active',
      numeric: true,
      cell: (row) => ({ text: formatDuration(row.activeMs) }),
    },
  ];

  if (view.costMode !== null) {
    const mode = view.costMode;
    columns.push({
      key: 'cost',
      label: 'Cost',
      numeric: true,
      cell: (row) => formatCost(getCost(report, row.costs, mode)),
    });
  }

  return columns;
}

/** The value a measure sorts by; null sorts last in either direction. */
function measureSortValue(
  context: ShareViewContext,
  row: Measured,
  key: TableSortKey,
): SortValue | undefined {
  switch (key) {
    case 'totalTokens':
    case 'inputTokens':
    case 'outputTokens':
    case 'cacheReadTokens':
    case 'eventCount':
    case 'activeMs':
      return row[key];
    case 'cacheHitRate':
      return getCacheHitRate(row);
    case 'cost':
      return getCostAmount(getCost(context.report, row.costs, context.view.costMode));
    default:
      return undefined;
  }
}

function toColumnViews<Row>(context: ShareViewContext, columns: Column<Row>[]): ColumnView[] {
  const { sort } = context.view;

  return columns.map((column) => {
    const sortKey =
      column.key === 'source' || column.key === 'models' || column.key === 'machines'
        ? undefined
        : column.key;
    const active = sortKey !== undefined && sort.key === sortKey;

    return {
      key: column.key,
      label: column.label,
      numeric: column.numeric,
      sortKey,
      narrow:
        column.key === 'label' ||
        column.key === 'totalTokens' ||
        column.key === (context.view.costMode === null ? 'eventCount' : 'cost'),
      sort: active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none',
    };
  });
}

/** Projects inside the view, sorted and paginated, with a total row over all of them. */
export function buildProjectTable(context: ShareViewContext, page: number): TableView {
  const { report, labels, view, cells } = context;
  const label = (row: ShareDimensionRow) => labels.of('project', row.index);
  const columns: Column<ShareDimensionRow>[] = [
    { key: 'label', label: 'Project', numeric: false, cell: (row) => ({ text: label(row) }) },
    ...measureColumns<ShareDimensionRow>(context),
  ];
  const sorted = sortRows(rollupByDimension(report, cells, 'project'), view.sort, (row, key) =>
    key === 'label' ? label(row) : (measureSortValue(context, row, key) ?? null),
  );
  const visible = paginate(sorted, page, TABLE_PAGE_SIZE);
  const totals = sumCells(report, cells);

  return {
    kind: 'projects',
    caption: 'Projects',
    columns: toColumnViews(context, columns),
    rows: visible.rows.map((row) => ({
      key: `project-${row.index}`,
      cells: columns.map((column) => column.cell(row)),
      drill: row.index,
    })),
    total:
      sorted.length > 0
        ? [
            { text: `All ${pluralize(sorted.length, 'project')}` },
            ...measureColumns<ShareTotals>(context).map((column) => column.cell(totals)),
          ]
        : undefined,
    page: visible.page,
    pageCount: visible.pageCount,
    rowCount: visible.rowCount,
    empty: 'No project has usage in this view.',
    omittedSessions: 0,
  };
}

/** One project's embedded sessions inside the view (the drill-down), sorted and paginated. */
export function buildSessionTable(
  context: ShareViewContext,
  project: number,
  page: number,
): TableView {
  const { report, labels, view } = context;
  const { timezone } = report.data.meta;
  const columns: Column<ShareSession>[] = [
    { key: 'label', label: 'Session', numeric: false, cell: (row) => ({ text: row.label }) },
    {
      key: 'source',
      label: 'Source',
      numeric: false,
      cell: (row) => ({ text: labels.of('source', row.source) }),
    },
    {
      key: 'models',
      label: 'Models',
      numeric: false,
      cell: (row) => ({ text: row.models.map((model) => labels.of('model', model)).join(', ') }),
    },
    {
      key: 'machines',
      label: 'Machines',
      numeric: false,
      cell: (row) => ({
        text: row.machines.map((machine) => labels.of('machine', machine)).join(', '),
      }),
    },
    {
      key: 'lastActivity',
      label: 'Last active',
      numeric: false,
      cell: (row) => ({ text: formatTimestamp(row.lastActivityAt, timezone) }),
    },
    ...measureColumns<ShareSession>(context),
  ];
  const sorted = sortRows(selectSessions(report, view, project), view.sort, (row, key) => {
    switch (key) {
      case 'label':
        return row.label;
      case 'lastActivity': {
        const time = Date.parse(row.lastActivityAt);
        return Number.isNaN(time) ? null : time;
      }
      default:
        return measureSortValue(context, row, key) ?? null;
    }
  });
  const visible = paginate(sorted, page, TABLE_PAGE_SIZE);
  const projectLabel = labels.of('project', project);

  return {
    kind: 'sessions',
    caption: `Sessions in ${projectLabel}`,
    columns: toColumnViews(context, columns),
    rows: visible.rows.map((row, position) => ({
      key: `session-${visible.page}-${position}`,
      cells: columns.map((column) => column.cell(row)),
    })),
    page: visible.page,
    pageCount: visible.pageCount,
    rowCount: visible.rowCount,
    empty: `No embedded session of ${projectLabel} was active in this view.`,
    omittedSessions: getOmittedSessionCount(report, project),
  };
}

/** The table the view shows: the drilled project's sessions, else the projects. */
export function buildTable(context: ShareViewContext, page: number): TableView {
  return context.view.drill === null
    ? buildProjectTable(context, page)
    : buildSessionTable(context, context.view.drill, page);
}

/** `21–40 of 63`: the rows on the page, for the pager. */
export function describePage(table: TableView): string {
  if (table.rowCount === 0) {
    return '0 rows';
  }

  const first = table.page * TABLE_PAGE_SIZE + 1;
  const last = Math.min(table.rowCount, first + TABLE_PAGE_SIZE - 1);

  return `${formatCount(first)}–${formatCount(last)} of ${formatCount(table.rowCount)}`;
}

/** The note under a drill-down whose project had more sessions than the file embeds. */
export function describeOmittedSessions(count: number): string | undefined {
  return count > 0
    ? `${pluralize(count, 'older session')} of this project ${count === 1 ? 'is' : 'are'} not embedded in the file.`
    : undefined;
}
