import os from 'node:os';
import path from 'node:path';

import type { DoctorSourceResult, DoctorSourceState } from '../cli/run-doctor-report.js';

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

function abbreviateHome(searchPath: string, homeDir: string): string {
  if (
    homeDir.length === 0 ||
    (searchPath !== homeDir && !searchPath.startsWith(homeDir + path.sep))
  ) {
    return searchPath;
  }

  return `~${searchPath.slice(homeDir.length)}`;
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

  return result.detail ?? `${result.itemsFound ?? 0} file(s)`;
}

function formatSummary(sourceResults: readonly DoctorSourceResult[]): string {
  const parts = summaryStates.flatMap(({ state, label }) => {
    const count = sourceResults.filter((result) => result.state === state).length;
    return count > 0 ? [`${count} ${label}`] : [];
  });

  return parts.length > 0 ? `Sources: ${parts.join(' · ')}` : 'Sources: none checked';
}

export function renderDoctorText(
  results: DoctorSourceResult[],
  options: { homeDir?: string } = {},
): string {
  const homeDir = options.homeDir ?? os.homedir();
  const idWidth = Math.max(...results.map((result) => result.id.length), 0);
  const formatWidth = Math.max(...results.map((result) => result.format.length), 0);
  const lines = results.flatMap((result) => [
    `${getGlyph(result)} ${result.id.padEnd(idWidth)}  ${result.format.padEnd(formatWidth)}  ${getDetail(result)}`,
    ...(result.searchedPaths ?? []).map(
      (searchPath) => `    ${abbreviateHome(searchPath, homeDir)}`,
    ),
  ]);
  const sourceResults = results.filter((result) => result.id !== 'event-store');

  return [...lines, '', formatSummary(sourceResults)].join('\n');
}
