// What the controls offer: granularities, the label filters with their options, cost modes
// and stacking dimensions. Pure; `render.ts` builds the inputs.

import type { ShareCostMode, ShareGranularity } from '../../../types.js';
import {
  compareText,
  COST_MODES,
  DIMENSION_DICTIONARY,
  getAvailableCostModes,
  SHARE_DIMENSIONS,
  type ShareDimension,
  type ShareReport,
} from '../../core/index.js';
import { formatDay, pluralize } from '../shell/format.js';
import { COST_MODE_DETAILS, COST_MODE_LABELS } from '../shell/model.js';
import type { ShareLabels } from '../state/context.js';

export const DIMENSION_LABELS: Record<ShareDimension, { one: string; many: string }> = {
  source: { one: 'Source', many: 'Sources' },
  model: { one: 'Model', many: 'Models' },
  project: { one: 'Project', many: 'Projects' },
  machine: { one: 'Machine', many: 'Machines' },
};

export type Option<Value extends string> = {
  value: Value;
  label: string;
  /** Why the option cannot be picked, when it cannot. */
  disabledReason?: string;
  /** A short line under the option. */
  detail?: string;
};

export function getGranularityOptions(report: ShareReport): Option<ShareGranularity>[] {
  const { hourlyFrom } = report.data.meta;

  return [
    {
      value: 'hour',
      label: 'Hour',
      detail: hourlyFrom === null ? undefined : `From ${formatDay(hourlyFrom)}`,
    },
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
  ];
}

/** Every mode, with the ones the file has no price for disabled; empty with --no-cost. */
export function getCostModeOptions(report: ShareReport): Option<ShareCostMode>[] {
  const available = getAvailableCostModes(report);

  if (report.data.meta.costMode === null && available.length === 0) {
    return [];
  }

  return COST_MODES.map((mode) => ({
    value: mode,
    label: COST_MODE_LABELS[mode],
    detail: COST_MODE_DETAILS[mode],
    disabledReason:
      available.includes(mode) && !report.data.meta.unavailableCostModes.includes(mode)
        ? undefined
        : 'Prices could not be loaded',
  }));
}

export function getStackOptions(): Option<ShareDimension>[] {
  return SHARE_DIMENSIONS.map((dimension) => ({
    value: dimension,
    label: DIMENSION_LABELS[dimension].one,
  }));
}

/** Total tokens per dictionary index of each dimension, over the whole file. */
export type DimensionTokens = Record<ShareDimension, number[]>;

export function countDimensionTokens(report: ShareReport): DimensionTokens {
  const { cube, dictionaries } = report.data;
  const count = (dimension: ShareDimension) => {
    const tokens = new Array<number>(dictionaries[DIMENSION_DICTIONARY[dimension]].length).fill(0);
    const column = cube[dimension];

    for (let cell = 0; cell < report.cellCount; cell += 1) {
      tokens[column[cell]] += cube.totalTokens[cell];
    }

    return tokens;
  };

  return {
    source: count('source'),
    model: count('model'),
    project: count('project'),
    machine: count('machine'),
  };
}

export type FilterOption = { index: number; label: string; selected: boolean };

export type FilterGroup = {
  dimension: ShareDimension;
  title: string;
  /** `All`, the one label picked, or how many are. */
  summary: string;
  /** True when the group keeps only some labels. */
  filtered: boolean;
  options: FilterOption[];
};

/**
 * One group per dimension with more than one label, options by tokens over the file (largest
 * first, ties by label) so the list does not move as the view changes.
 */
export function getFilterGroups(
  report: ShareReport,
  tokens: DimensionTokens,
  selected: Record<ShareDimension, readonly number[]>,
  labels: ShareLabels,
): FilterGroup[] {
  return SHARE_DIMENSIONS.flatMap((dimension) => {
    const size = report.data.dictionaries[DIMENSION_DICTIONARY[dimension]].length;

    if (size < 2) {
      return [];
    }

    const picked = selected[dimension];
    const options = Array.from({ length: size }, (_, index) => ({
      index,
      label: labels.of(dimension, index),
      selected: picked.includes(index),
    })).sort(
      (left, right) =>
        tokens[dimension][right.index] - tokens[dimension][left.index] ||
        compareText(left.label, right.label),
    );
    const names = DIMENSION_LABELS[dimension];
    const summary =
      picked.length === 0
        ? 'All'
        : picked.length === 1
          ? labels.of(dimension, picked[0])
          : pluralize(picked.length, names.one.toLowerCase());

    return [{ dimension, title: names.many, summary, filtered: picked.length > 0, options }];
  });
}
