// The page's state and the changes the controls make to it. The view half lives in the URL
// hash (`core/view-state.ts`); names-hidden and the table page are display-only and are not
// shared. Every change returns a new state, and a change that would make the view invalid
// (an end before the start, a date outside the window) leaves it as it was.

import { shiftDateKey } from '../../../../utils/date-key.js';
import {
  decodeViewState,
  encodeViewState,
  getDefaultViewState,
  getWindowEnd,
  SHARE_DIMENSIONS,
  type ShareDimension,
  type ShareFilters,
  type ShareReport,
  type ShareTheme,
  type ShareViewState,
  type TableSort,
  type TableSortKey,
} from '../../core/index.js';

/** A hash with no field: it decodes to the command view instead of the saved one. */
const DEFAULT_VIEW_HASH = 'default';

export type ShareUiState = {
  view: ShareViewState;
  /** "Hide names": masks project and machine labels on screen and in exports. */
  hideNames: boolean;
  /** The table page, 0-based; back to 0 whenever the rows change. */
  page: number;
};

/**
 * The view the page opens on: the URL hash when it has one, else the view a saved file
 * carries, else the command's own. Anything invalid falls back field by field.
 */
export function resolveInitialView(
  hash: string,
  savedHash: string | undefined,
  report: ShareReport,
): ShareViewState {
  const own = hash.replace(/^#/u, '');
  return decodeViewState(own === '' ? (savedHash ?? '') : own, report);
}

/**
 * The URL hash for a view: its fields that differ from the command view. When it has none but
 * the file carries a saved view, a marker that decodes to the command view, since an empty
 * hash reopens on the saved one.
 */
export function toUrlHash(
  view: ShareViewState,
  report: ShareReport,
  savedHash: string | undefined,
): string {
  const hash = encodeViewState(view, report);
  return hash === '' && savedHash !== undefined && savedHash !== '' ? DEFAULT_VIEW_HASH : hash;
}

/** A view change: the rows change, so the table goes back to its first page. */
export function withView(state: ShareUiState, patch: Partial<ShareViewState>): ShareUiState {
  return { ...state, view: { ...state.view, ...patch }, page: 0 };
}

function isInsideWindow(dateKey: string | null, report: ShareReport): boolean {
  const { since, until } = report.data.meta.window;
  return (
    dateKey === null ||
    ((since === null || dateKey >= since) && (until === null || dateKey <= until))
  );
}

/** Sets the period; an inverted range or a date outside the window keeps the old one. */
export function withPeriod(
  state: ShareUiState,
  report: ShareReport,
  since: string | null,
  until: string | null,
): ShareUiState {
  if (
    !isInsideWindow(since, report) ||
    !isInsideWindow(until, report) ||
    (since !== null && until !== null && since > until)
  ) {
    return state;
  }

  return withView(state, { since, until });
}

/** Sets one dimension's filter: the dictionary indexes to keep, empty for all. */
export function withFilter(
  state: ShareUiState,
  dimension: ShareDimension,
  indexes: number[],
): ShareUiState {
  return withView(state, { [dimension]: indexes });
}

/** True when a source, model, project or machine filter is set. */
export function hasLabelFilters(view: ShareFilters): boolean {
  return SHARE_DIMENSIONS.some((dimension) => view[dimension].length > 0);
}

/** Adds or removes one index from a filter, keeping it sorted as the hash writes it. */
export function toggleIndex(indexes: readonly number[], index: number): number[] {
  return indexes.includes(index)
    ? indexes.filter((item) => item !== index)
    : [...indexes, index].sort((left, right) => left - right);
}

/** A header click: the same column flips direction; a new one starts A–Z for text, largest first otherwise. */
export function nextSort(sort: TableSort, key: TableSortKey): TableSort {
  if (sort.key === key) {
    return { key, direction: sort.direction === 'asc' ? 'desc' : 'asc' };
  }

  return { key, direction: key === 'label' ? 'asc' : 'desc' };
}

/** The theme drawn: the chosen one, or the system's when the view says `auto`. */
export function resolveTheme(theme: ShareTheme, systemPrefersDark: boolean): 'light' | 'dark' {
  if (theme === 'auto') {
    return systemPrefersDark ? 'dark' : 'light';
  }

  return theme;
}

/** Back to the command's view, keeping the display-only choices. */
export function resetView(state: ShareUiState, report: ShareReport): ShareUiState {
  return { ...state, view: { ...getDefaultViewState(report), theme: state.view.theme }, page: 0 };
}

/** Keeps the period, clears every label filter. */
export function clearFilters(state: ShareUiState): ShareUiState {
  return withView(state, { source: [], model: [], project: [], machine: [] });
}

export type PeriodPreset = {
  id: string;
  label: string;
  since: string | null;
  until: string | null;
};

/**
 * Shortcuts for the period: the command's own view, the last 7, 30 and 90 days that fit in
 * the window, and the whole window. Presets that equal an earlier one are left out.
 */
export function getPeriodPresets(report: ShareReport): PeriodPreset[] {
  const { initialView, window } = report.data.meta;
  const last = getWindowEnd(report);
  const presets: PeriodPreset[] = [
    { id: 'opening', label: 'Opening view', since: initialView.since, until: initialView.until },
  ];

  if (last !== undefined) {
    for (const days of [7, 30, 90]) {
      const since = shiftDateKey(last, 1 - days);

      if (window.since === null || since >= window.since) {
        presets.push({ id: `last-${days}`, label: `Last ${days} days`, since, until: last });
      }
    }
  }

  presets.push({ id: 'window', label: 'Whole file', since: window.since, until: window.until });

  return presets.filter(
    (preset, index) =>
      presets.findIndex((other) => other.since === preset.since && other.until === preset.until) ===
      index,
  );
}
