import os from 'node:os';
import path from 'node:path';

import type { DoctorSourceResult, DoctorSourceState } from '../cli/run-doctor-report.js';
import { pluralize } from '@ayagmar/agent-sessions/internal';

const doctorStatusGlyphs = { ok: '✔', error: '✖' } as const;

const doctorStateGlyphs: Record<DoctorSourceState, string> = {
  found: '✔',
  not_installed: '○',
  unparseable: '⚠',
  error: '✖',
};

/** Summary order: what works, then what needs attention, then what is simply absent. */
const summaryStates: readonly { state: DoctorSourceState; label: string }[] = [
  { state: 'found', label: 'found' },
  { state: 'unparseable', label: 'unparseable' },
  { state: 'error', label: 'failed' },
  { state: 'not_installed', label: 'not installed' },
];

export function abbreviateHome(searchPath: string, homeDir: string): string {
  if (
    homeDir.length === 0 ||
    (searchPath !== homeDir && !searchPath.startsWith(homeDir + path.sep))
  ) {
    return searchPath;
  }

  return `~${searchPath.slice(homeDir.length)}`;
}

/** The event store line when its file does not exist yet. */
export function describeMissingEventStore(legacyPath: string | undefined): string {
  return legacyPath === undefined
    ? 'not yet created'
    : `still at ${legacyPath}; the next report copies it here`;
}

function getGlyph(result: DoctorSourceResult): string {
  return result.state ? doctorStateGlyphs[result.state] : doctorStatusGlyphs[result.status];
}

function getDetail(result: DoctorSourceResult): string {
  if (result.status === 'error') {
    return result.error ?? 'Unknown';
  }

  if (result.state === 'not_installed') {
    return result.detail ?? 'not installed (no files found)';
  }

  return result.detail ?? pluralize(result.itemsFound ?? 0, 'file');
}

function formatSummary(
  sourceResults: readonly DoctorSourceResult[],
  collapsedCount: number,
): string {
  const parts = summaryStates.flatMap(({ state, label }) => {
    const count = sourceResults.filter((result) => result.state === state).length;
    return count > 0 ? [`${count} ${label}`] : [];
  });
  const pathsHint = collapsedCount > 0 ? '; --verbose shows where they were searched' : '';

  return parts.length > 0 ? `Sources: ${parts.join(' · ')}${pathsHint}` : 'Sources: none checked';
}

/** A not-installed source on the default search paths: the common case, so one line covers it. */
function isCollapsible(result: DoctorSourceResult): boolean {
  return result.state === 'not_installed' && result.detail === undefined;
}

export function renderDoctorText(
  results: DoctorSourceResult[],
  options: { homeDir?: string; showAllPaths?: boolean } = {},
): string {
  const homeDir = options.homeDir ?? os.homedir();
  const collapsed = options.showAllPaths ? [] : results.filter(isCollapsible);
  const shown = results.filter((result) => !collapsed.includes(result));
  const idWidth = Math.max(...shown.map((result) => result.id.length), 0);
  const formatWidth = Math.max(...shown.map((result) => result.format.length), 0);
  const renderRow = (result: DoctorSourceResult): string[] => [
    `${getGlyph(result)} ${result.id.padEnd(idWidth)}  ${result.format.padEnd(formatWidth)}  ${getDetail(result)}`,
    ...(result.searchedPaths ?? []).map(
      (searchPath) => `    ${abbreviateHome(searchPath, homeDir)}`,
    ),
  ];
  // Sources come first in results; the collapsed line closes them, before the store and machines.
  const notInstalledLine =
    collapsed.length > 0
      ? [
          `${doctorStateGlyphs.not_installed} not installed: ${collapsed.map((result) => result.id).join(', ')}`,
        ]
      : [];
  const lines = [
    ...shown.filter((result) => result.state !== undefined).flatMap(renderRow),
    ...notInstalledLine,
    ...shown.filter((result) => result.state === undefined).flatMap(renderRow),
  ];
  const sourceResults = results.filter((result) => result.state !== undefined);
  const hasMachines = results.some((result) => result.format === 'ssh');
  const tip = hasMachines
    ? []
    : [
        'Tip: add your other machines to every report with llm-usage machine add <name> [user@host]',
      ];

  return [...lines, '', formatSummary(sourceResults, collapsed.length), ...tip].join('\n');
}
