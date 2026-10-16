// What every part of the page renders from: the report, the current view, the cells it
// selects and the labels to show. Charts (`../charts`) and panels (`../panels`) receive one
// of these per render and never read the URL or the DOM state themselves.

import {
  buildNameMask,
  DIMENSION_DICTIONARY,
  getViewDateSpan,
  selectCells,
  type ShareDateSpan,
  type ShareDimension,
  type ShareNameMask,
  type ShareReport,
  type ShareViewState,
} from '../../core/index.js';

/** Labels as the page shows them: with "Hide names" on, projects and machines are masked. */
export type ShareLabels = {
  /** True while "Hide names" is on; exports must use these labels too. */
  hidden: boolean;
  /** The label of a dictionary index. */
  of: (dimension: ShareDimension, index: number) => string;
  /**
   * A project label from an embedded envelope, by its original text; a label the dictionaries
   * do not hold shows as {@link HIDDEN_LABEL} while names are hidden.
   */
  project: (label: string) => string;
  /** A machine name from an embedded envelope, by its original text. */
  machine: (label: string) => string;
};

export type ShareViewContext = {
  report: ShareReport;
  view: ShareViewState;
  /** The cube cells inside the view's period and filters. */
  cells: readonly number[];
  /** The dates the view spans (a chart axis's fixed ends); undefined for an empty file. */
  span: ShareDateSpan | undefined;
  labels: ShareLabels;
  /** The theme drawn, for exports. */
  theme: 'light' | 'dark';
};

/** The labels for a view; `mask` is built once per file with `buildNameMask`. */
export function createLabels(report: ShareReport, mask: ShareNameMask | undefined): ShareLabels {
  const { dictionaries } = report.data;

  return {
    hidden: mask !== undefined,
    of: (dimension, index) => {
      if (mask && dimension === 'project') {
        return mask.projects[index];
      }

      if (mask && dimension === 'machine') {
        return mask.machines[index];
      }

      return dictionaries[DIMENSION_DICTIONARY[dimension]][index];
    },
    project: (label) => maskEnvelopeLabel(mask?.project, label),
    machine: (label) => maskEnvelopeLabel(mask?.machine, label),
  };
}

/** What "Hide names" shows for an envelope label the dictionaries do not hold. */
export const HIDDEN_LABEL = '(hidden)';

// The labels that name no one, as `buildNameMask` keeps them.
const OPEN_LABELS = new Set(['local', '(unattributed)']);

function maskEnvelopeLabel(map: ReadonlyMap<string, string> | undefined, label: string): string {
  if (!map) {
    return label;
  }

  return map.get(label) ?? (OPEN_LABELS.has(label) ? label : HIDDEN_LABEL);
}

/** The mask for "Hide names", built on first use and kept for the file. */
export function createMaskSource(report: ShareReport): () => ShareNameMask {
  let mask: ShareNameMask | undefined;
  return () => (mask ??= buildNameMask(report));
}

export function buildViewContext(
  report: ShareReport,
  view: ShareViewState,
  labels: ShareLabels,
  theme: 'light' | 'dark',
): ShareViewContext {
  return {
    report,
    view,
    cells: selectCells(report, view),
    span: getViewDateSpan(report, view),
    labels,
    theme,
  };
}
