import type { ShareReport } from './decode.js';
import { compareByCodePoint } from '../../../../packages/core/src/utils/compare-by-code-point.js';

/** Labels that name no one, so "Hide names" keeps them. */
const UNMASKED_LABELS = new Set(['local', '(unattributed)']);

/**
 * Display labels for "Hide names": aligned with the project and machine dictionaries, and by
 * original label for strings in embedded panels. The file itself is unchanged.
 */
export type ShareNameMask = {
  projects: string[];
  machines: string[];
  project: ReadonlyMap<string, string>;
  machine: ReadonlyMap<string, string>;
};

function maskDictionary(
  labels: readonly string[],
  tokens: readonly number[],
  prefix: string,
): string[] {
  const masked = [...labels];
  const order = labels
    .map((label, index) => ({ label, index, tokens: tokens[index] }))
    .filter((entry) => !UNMASKED_LABELS.has(entry.label))
    .sort(
      (left, right) => right.tokens - left.tokens || compareByCodePoint(left.label, right.label),
    );

  order.forEach((entry, rank) => {
    masked[entry.index] = `${prefix}-${rank + 1}`;
  });

  return masked;
}

function tokensByIndex(report: ShareReport, column: readonly number[], size: number): number[] {
  const tokens = new Array<number>(size).fill(0);
  const { totalTokens } = report.data.cube;

  column.forEach((index, cell) => {
    tokens[index] += totalTokens[cell];
  });

  return tokens;
}

/**
 * `project-1…n` and `machine-1…n`, numbered by total tokens (ties by label) as `--redact` does;
 * `local` and `(unattributed)` stay. A redacted file keeps its labels.
 */
export function buildNameMask(report: ShareReport): ShareNameMask {
  const { cube, dictionaries, meta } = report.data;
  const projects = meta.redacted
    ? [...dictionaries.projects]
    : maskDictionary(
        dictionaries.projects,
        tokensByIndex(report, cube.project, dictionaries.projects.length),
        'project',
      );
  const machines = meta.redacted
    ? [...dictionaries.machines]
    : maskDictionary(
        dictionaries.machines,
        tokensByIndex(report, cube.machine, dictionaries.machines.length),
        'machine',
      );

  return {
    projects,
    machines,
    project: new Map(dictionaries.projects.map((label, index) => [label, projects[index]])),
    machine: new Map(dictionaries.machines.map((label, index) => [label, machines[index]])),
  };
}
