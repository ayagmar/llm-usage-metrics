import type { ShareSession } from '../../types.js';
import type { ShareReport } from './decode.js';
import type { ShareFilters } from './filters.js';
import { toLocalDateHour } from './local-time.js';
import { compareByCodePoint } from '../../../../packages/core/src/utils/compare-by-code-point.js';

export type SortDirection = 'asc' | 'desc';

/** The sortable columns of the project and session tables. */
export const TABLE_SORT_KEYS = [
  'label',
  'totalTokens',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'eventCount',
  'activeMs',
  'cost',
  'cacheHitRate',
  'lastActivity',
] as const;

export type TableSortKey = (typeof TABLE_SORT_KEYS)[number];

export type TableSort = { key: TableSortKey; direction: SortDirection };

/** A sortable value: a number or text, or null for an empty cell. */
export type SortValue = number | string | null;

export type TablePage<Row> = {
  rows: Row[];
  /** The page shown, clamped into range: 0-based. */
  page: number;
  pageCount: number;
  rowCount: number;
};

function compareValues(left: SortValue, right: SortValue): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }

  return compareByCodePoint(String(left), String(right));
}

/**
 * A sorted copy: empty cells last in either direction, ties by label ascending, then by input
 * order, so the same rows always sort the same way.
 */
export function sortRows<Row>(
  rows: readonly Row[],
  sort: TableSort,
  valueOf: (row: Row, key: TableSortKey) => SortValue,
): Row[] {
  const sign = sort.direction === 'asc' ? 1 : -1;

  return rows
    .map((row, position) => ({
      row,
      position,
      value: valueOf(row, sort.key),
      label: String(valueOf(row, 'label') ?? ''),
    }))
    .sort((left, right) => {
      if (left.value === null || right.value === null) {
        return (
          Number(left.value === null) - Number(right.value === null) ||
          compareByCodePoint(left.label, right.label) ||
          left.position - right.position
        );
      }

      return (
        sign * compareValues(left.value, right.value) ||
        compareByCodePoint(left.label, right.label) ||
        left.position - right.position
      );
    })
    .map(({ row }) => row);
}

/** One page of rows; an out-of-range or invalid page shows the nearest page. */
export function paginate<Row>(
  rows: readonly Row[],
  page: number,
  pageSize: number,
): TablePage<Row> {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const clamped = Number.isInteger(page) ? Math.min(Math.max(page, 0), pageCount - 1) : 0;

  return {
    rows: rows.slice(clamped * size, (clamped + 1) * size),
    page: clamped,
    pageCount,
    rowCount: rows.length,
  };
}

function intersects(values: readonly number[], selected: readonly number[]): boolean {
  return selected.length === 0 || values.some((value) => selected.includes(value));
}

/**
 * The embedded sessions inside the filters, optionally of one project (the drill-down): active
 * in the date range, of a kept source and project, and with a kept model and machine. A
 * session's figures are its own totals, not narrowed by the model or machine filter.
 */
export function selectSessions(
  report: ShareReport,
  filters: ShareFilters,
  project: number | null,
): ShareSession[] {
  const { timezone } = report.data.meta;

  return report.data.sessions.rows.filter((session) => {
    if (
      (project !== null && session.project !== project) ||
      !intersects([session.source], filters.source) ||
      !intersects([session.project], filters.project) ||
      !intersects(session.models, filters.model) ||
      !intersects(session.machines, filters.machine)
    ) {
      return false;
    }

    const first = toLocalDateHour(session.firstActivityAt, timezone)?.dateKey;
    const last = toLocalDateHour(session.lastActivityAt, timezone)?.dateKey;

    return (
      first !== undefined &&
      last !== undefined &&
      (filters.until === null || first <= filters.until) &&
      (filters.since === null || last >= filters.since)
    );
  });
}

/** How many of a project's sessions the file left out (the per-project cap); 0 when none. */
export function getOmittedSessionCount(report: ShareReport, project: number | null): number {
  return report.data.sessions.omitted
    .filter((entry) => project === null || entry.project === project)
    .reduce((sum, entry) => sum + entry.count, 0);
}
