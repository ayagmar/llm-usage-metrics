import { parseDateKey } from '../../../utils/date-key.js';
import type { ShareCostMode, ShareGranularity } from '../../types.js';
import { GRANULARITIES, type ShareReport } from './decode.js';
import {
  DIMENSION_DICTIONARY,
  SHARE_DIMENSIONS,
  type ShareDimension,
  type ShareFilters,
} from './filters.js';
import { getAvailableCostModes, getDefaultCostMode } from './metrics.js';
import { TABLE_SORT_KEYS, type TableSort } from './table.js';

export type ShareTheme = 'auto' | 'light' | 'dark';

/** Everything the URL hash holds; filters are dictionary indexes, never labels. */
export type ShareViewState = ShareFilters & {
  granularity: ShareGranularity;
  costMode: ShareCostMode | null;
  /** The dimension the over-time charts stack by. */
  stackBy: ShareDimension;
  theme: ShareTheme;
  sort: TableSort;
  /** The project whose sessions are shown; null for the project table. */
  drill: number | null;
};

const THEMES: readonly ShareTheme[] = ['auto', 'light', 'dark'];

// Short keys keep shared URLs readable; each is decoded on its own.
const HASH_KEYS: Record<keyof ShareViewState, string> = {
  since: 'from',
  until: 'to',
  granularity: 'g',
  source: 'src',
  model: 'model',
  project: 'proj',
  machine: 'mach',
  costMode: 'cost',
  stackBy: 'stack',
  theme: 'theme',
  sort: 'sort',
  drill: 'drill',
};
const VIEW_FIELDS: readonly (keyof ShareViewState)[] = [
  'since',
  'until',
  'granularity',
  'source',
  'model',
  'project',
  'machine',
  'costMode',
  'stackBy',
  'theme',
  'sort',
  'drill',
];

/** The view the page opens on: the command's initial view, every label, its cost mode. */
export function getDefaultViewState(report: ShareReport): ShareViewState {
  const { initialView } = report.data.meta;
  const costMode = getDefaultCostMode(report);

  return {
    since: initialView.since,
    until: initialView.until,
    granularity: initialView.granularity,
    source: [],
    model: [],
    project: [],
    machine: [],
    costMode,
    stackBy: 'source',
    theme: 'auto',
    sort: { key: costMode === null ? 'totalTokens' : 'cost', direction: 'desc' },
    drill: null,
  };
}

function encodeIndexes(indexes: readonly number[]): string {
  return [...new Set(indexes)].sort((left, right) => left - right).join('.');
}

function encodeSort(sort: TableSort): string {
  return `${sort.direction === 'desc' ? '-' : ''}${sort.key}`;
}

function encodeValue(state: ShareViewState, field: keyof ShareViewState): string {
  switch (field) {
    case 'source':
    case 'model':
    case 'project':
    case 'machine':
      return encodeIndexes(state[field]);
    case 'sort':
      return encodeSort(state.sort);
    default:
      return String(state[field] ?? '');
  }
}

/**
 * The hash (without `#`) for a view: only the fields that differ from the default, so a plain
 * file opens on its own view and a hash stays short. Empty when the view is the default.
 */
export function encodeViewState(state: ShareViewState, report: ShareReport): string {
  const defaults = getDefaultViewState(report);
  const parts: string[] = [];

  for (const field of VIEW_FIELDS) {
    const value = encodeValue(state, field);

    if (value !== encodeValue(defaults, field)) {
      parts.push(`${HASH_KEYS[field]}=${value}`);
    }
  }

  return parts.join('&');
}

/** An open end (empty), a date inside the window, or undefined for anything else. */
function decodeDate(value: string, report: ShareReport): string | null | undefined {
  if (value === '') {
    return null;
  }

  const { since, until } = report.data.meta.window;

  if (
    !parseDateKey(value) ||
    (since !== null && value < since) ||
    (until !== null && value > until)
  ) {
    return undefined;
  }

  return value;
}

function decodeIndexes(value: string, size: number): number[] | undefined {
  if (value === '') {
    return [];
  }

  const indexes: number[] = [];

  for (const part of value.split('.')) {
    if (!/^\d{1,6}$/u.test(part) || Number(part) >= size) {
      return undefined;
    }

    indexes.push(Number(part));
  }

  return [...new Set(indexes)].sort((left, right) => left - right);
}

function decodeSort(value: string): TableSort | undefined {
  const direction = value.startsWith('-') ? 'desc' : 'asc';
  const key = direction === 'desc' ? value.slice(1) : value;

  const sortKey = pickOne(key, TABLE_SORT_KEYS);
  return sortKey && { key: sortKey, direction };
}

function pickOne<Value extends string>(
  value: string | undefined,
  allowed: readonly Value[],
): Value | undefined {
  return allowed.find((item) => item === value);
}

function readHashParams(hash: string): Map<string, string> {
  const params = new Map<string, string>();

  for (const part of hash.replace(/^#/u, '').split('&')) {
    const separator = part.indexOf('=');

    if (separator <= 0) {
      continue;
    }

    try {
      params.set(
        decodeURIComponent(part.slice(0, separator)),
        decodeURIComponent(part.slice(separator + 1)),
      );
    } catch {
      // A malformed escape leaves that field at its default.
    }
  }

  return params;
}

/**
 * The view a hash describes. Each field that is missing, malformed or stale (an index past its
 * dictionary, a date outside the window, a cost mode the file lacks) keeps its default, so
 * any hash opens a valid view and nothing throws.
 */
export function decodeViewState(hash: string, report: ShareReport): ShareViewState {
  const state = getDefaultViewState(report);
  const params = readHashParams(hash);
  const read = (field: keyof ShareViewState) => params.get(HASH_KEYS[field]);
  const since = read('since');
  const until = read('until');
  const decodedSince = since === undefined ? state.since : decodeDate(since, report);
  const decodedUntil = until === undefined ? state.until : decodeDate(until, report);

  if (
    decodedSince !== undefined &&
    decodedUntil !== undefined &&
    (decodedSince === null || decodedUntil === null || decodedSince <= decodedUntil)
  ) {
    state.since = decodedSince;
    state.until = decodedUntil;
  }

  for (const dimension of SHARE_DIMENSIONS) {
    const value = read(dimension);
    const size = report.data.dictionaries[DIMENSION_DICTIONARY[dimension]].length;
    state[dimension] =
      (value === undefined ? undefined : decodeIndexes(value, size)) ?? state[dimension];
  }

  state.granularity = pickOne(read('granularity'), GRANULARITIES) ?? state.granularity;
  state.costMode =
    pickOne(
      read('costMode'),
      getAvailableCostModes(report).filter(
        (mode) => !report.data.meta.unavailableCostModes.includes(mode),
      ),
    ) ?? state.costMode;
  state.stackBy = pickOne(read('stackBy'), SHARE_DIMENSIONS) ?? state.stackBy;
  state.theme = pickOne(read('theme'), THEMES) ?? state.theme;

  const sort = read('sort');
  state.sort = (sort === undefined ? undefined : decodeSort(sort)) ?? state.sort;

  const drill = read('drill');

  if (drill !== undefined) {
    const projects = decodeIndexes(drill, report.data.dictionaries.projects.length);
    state.drill =
      projects?.length === 1 && drill === String(projects[0]) ? projects[0] : state.drill;
  }

  return state;
}
