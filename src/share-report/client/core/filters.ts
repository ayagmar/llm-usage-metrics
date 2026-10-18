import type { ShareReport } from './decode.js';

/** The cube's label dimensions, each indexing its dictionary. */
export type ShareDimension = 'source' | 'model' | 'project' | 'machine';

export const SHARE_DIMENSIONS: readonly ShareDimension[] = [
  'source',
  'model',
  'project',
  'machine',
];

/** Dictionary name for each dimension. */
export const DIMENSION_DICTIONARY = {
  source: 'sources',
  model: 'models',
  project: 'projects',
  machine: 'machines',
} as const satisfies Record<ShareDimension, string>;

/**
 * What the page shows: a `YYYY-MM-DD` range of local dates (null ends are open) and, per
 * dimension, the dictionary indexes to keep (empty keeps all).
 */
export type ShareFilters = {
  since: string | null;
  until: string | null;
  source: number[];
  model: number[];
  project: number[];
  machine: number[];
};

export function createFilters(range: { since: string | null; until: string | null }): ShareFilters {
  return {
    since: range.since,
    until: range.until,
    source: [],
    model: [],
    project: [],
    machine: [],
  };
}

function isInDateRange(dateKey: string, filters: ShareFilters): boolean {
  return (
    (filters.since === null || dateKey >= filters.since) &&
    (filters.until === null || dateKey <= filters.until)
  );
}

/** True when a model, project or machine filter is set: blocks cannot honour those. */
export function hasBlockIgnoredFilters(filters: ShareFilters): boolean {
  return filters.model.length > 0 || filters.project.length > 0 || filters.machine.length > 0;
}

function toMembership(indexes: readonly number[], size: number): boolean[] | undefined {
  if (indexes.length === 0) {
    return undefined;
  }

  const membership = new Array<boolean>(size).fill(false);

  for (const index of indexes) {
    membership[index] = true;
  }

  return membership;
}

/** The indexes of the cube cells inside the filters, in cube order. */
export function selectCells(report: ShareReport, filters: ShareFilters): number[] {
  const { cube, dictionaries } = report.data;
  const periodIn = report.periods.map((period) => isInDateRange(period.dateKey, filters));
  const memberships = SHARE_DIMENSIONS.map(
    (dimension) =>
      [
        cube[dimension],
        toMembership(filters[dimension], dictionaries[DIMENSION_DICTIONARY[dimension]].length),
      ] as const,
  );
  const cells: number[] = [];

  for (let cell = 0; cell < report.cellCount; cell += 1) {
    if (
      periodIn[cube.period[cell]] &&
      memberships.every(([column, membership]) => !membership || membership[column[cell]])
    ) {
      cells.push(cell);
    }
  }

  return cells;
}
