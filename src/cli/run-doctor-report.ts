import { createDefaultAdapters, getDefaultSourceIds } from '../sources/create-default-adapters.js';
import type { SourceAdapter } from '../sources/source-adapter.js';
import { normalizeSourceFilter, validateSourceFilterValues } from './build-usage-data-inputs.js';
import type { DoctorCommandOptions } from './usage-data-contracts.js';

export type DoctorSourceResult = {
  id: string;
  status: 'ok' | 'error';
  itemsFound?: number;
  error?: string;
};

function getErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectDoctorAdapters(
  adapters: SourceAdapter[],
  source: DoctorCommandOptions['source'],
): SourceAdapter[] {
  const sourceFilter = normalizeSourceFilter(source);
  validateSourceFilterValues(sourceFilter, new Set(getDefaultSourceIds()));

  if (!sourceFilter) {
    return adapters;
  }

  return adapters.filter((adapter) => sourceFilter.has(adapter.id.toLowerCase()));
}

export async function buildDoctorResults(
  options: DoctorCommandOptions,
): Promise<DoctorSourceResult[]> {
  const adapters = selectDoctorAdapters(createDefaultAdapters(options), options.source);
  const results: DoctorSourceResult[] = [];

  for (const adapter of adapters) {
    try {
      const files = await adapter.discoverFiles();
      results.push({
        id: adapter.id,
        status: 'ok',
        itemsFound: files.length,
      });
    } catch (error) {
      results.push({
        id: adapter.id,
        status: 'error',
        error: getErrorReason(error),
      });
    }
  }

  return results;
}

function renderDoctorText(results: DoctorSourceResult[]): string {
  const idWidth = Math.max(...results.map((result) => result.id.length), 0);
  const statusWidth = 5;
  const lines = results.map((result) => {
    const detail =
      result.status === 'ok' ? `${result.itemsFound ?? 0} file(s)` : (result.error ?? 'Unknown');

    return `${result.id.padEnd(idWidth)}  ${result.status.padEnd(statusWidth)}  ${detail}`;
  });
  const healthyCount = results.filter((result) => result.status === 'ok').length;

  return [...lines, '', `${healthyCount}/${results.length} sources healthy`].join('\n');
}

export async function runDoctorReport(options: DoctorCommandOptions): Promise<void> {
  const results = await buildDoctorResults(options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ sources: results }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderDoctorText(results)}\n`);
}
