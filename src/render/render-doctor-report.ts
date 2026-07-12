import type { DoctorSourceResult } from '../cli/run-doctor-report.js';

const doctorStatusGlyphs = { ok: '✔', error: '✖' } as const;

export function renderDoctorText(results: DoctorSourceResult[]): string {
  const idWidth = Math.max(...results.map((result) => result.id.length), 0);
  const formatWidth = Math.max(...results.map((result) => result.format.length), 0);
  const lines = results.map((result) => {
    const detail =
      result.status === 'ok'
        ? (result.detail ?? `${result.itemsFound ?? 0} file(s)`)
        : (result.error ?? 'Unknown');

    return `${doctorStatusGlyphs[result.status]} ${result.id.padEnd(idWidth)}  ${result.format.padEnd(formatWidth)}  ${detail}`;
  });
  const sourceResults = results.filter((result) => result.id !== 'event-store');
  const healthyCount = sourceResults.filter((result) => result.status === 'ok').length;

  return [...lines, '', `${healthyCount}/${sourceResults.length} sources healthy`].join('\n');
}
