import { stat } from 'node:fs/promises';

import { getEventStoreRuntimeConfig } from '../config/runtime-overrides.js';
import {
  EVENT_STORE_SCHEMA_VERSION,
  readEventStoreStoredFiles as readDefaultEventStoreStoredFiles,
  readEventStoreSummary as readDefaultEventStoreSummary,
  type EventStoreStoredFile,
  type EventStoreSummary,
} from '../persistence/event-store.js';
import {
  createDefaultAdapters,
  getDefaultSourceIds,
  getSourceStorageFormat,
  type SourceStorageFormat,
} from '../sources/create-default-adapters.js';
import type { SourceAdapter } from '../sources/source-adapter.js';
import { logger } from '../utils/logger.js';
import { normalizeSourceFilter, validateSourceFilterValues } from './build-usage-data-inputs.js';
import { resolveUserConfigForOptions, type UserConfigResolutionDeps } from './apply-user-config.js';
import { emitUserConfigResolution } from './emit-active-config.js';
import type { DoctorCommandOptions } from './usage-data-contracts.js';

export type DoctorSourceResult = {
  id: string;
  format: SourceStorageFormat;
  status: 'ok' | 'error';
  itemsFound?: number;
  detail?: string;
  error?: string;
};

type DoctorDeps = UserConfigResolutionDeps & {
  getEventStoreRuntimeConfig?: typeof getEventStoreRuntimeConfig;
  readEventStoreStoredFiles?: (filePath: string) => Promise<EventStoreStoredFile[]>;
  readEventStoreSummary?: (filePath: string) => Promise<EventStoreSummary>;
};

type DiscoveredFilesBySource = Map<string, Set<string>>;

function getErrorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
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
  deps: DoctorDeps = {},
): Promise<DoctorSourceResult[]> {
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options;
  const adapters = selectDoctorAdapters(
    createDefaultAdapters(configuredOptions),
    configuredOptions.source,
  );
  const results: DoctorSourceResult[] = [];
  const discoveredFilesBySource: DiscoveredFilesBySource = new Map();

  for (const adapter of adapters) {
    const format = getSourceStorageFormat(adapter.id.toLowerCase());

    try {
      const files = await adapter.discoverFiles();
      discoveredFilesBySource.set(adapter.id.toLowerCase(), new Set(files));
      results.push({
        id: adapter.id,
        format,
        status: 'ok',
        itemsFound: files.length,
      });
    } catch (error) {
      results.push({
        id: adapter.id,
        format,
        status: 'error',
        error: getErrorReason(error),
      });
    }
  }

  const eventStoreRuntimeConfig = (deps.getEventStoreRuntimeConfig ?? getEventStoreRuntimeConfig)(
    process.env,
    userConfigResolution.loadedConfig.config,
  );

  if (eventStoreRuntimeConfig.enabled) {
    results.push(
      await buildEventStoreDoctorResult(
        eventStoreRuntimeConfig.path,
        discoveredFilesBySource,
        deps,
      ),
    );
  }

  return results;
}

function formatByteSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function isSupportedStoreSchemaVersion(schemaVersion: string | undefined): boolean {
  return schemaVersion === '1' || schemaVersion === EVENT_STORE_SCHEMA_VERSION;
}

function getUnsupportedSchemaError(schemaVersion: string | undefined): string {
  const versionLabel = schemaVersion ? `v${schemaVersion}` : 'unknown';
  return `Event store schema ${versionLabel} is not supported by this llm-usage-metrics version (supports v${EVENT_STORE_SCHEMA_VERSION}); upgrade llm-usage-metrics or set LLM_USAGE_EVENT_STORE=0`;
}

function countDepartedFiles(
  storedFiles: EventStoreStoredFile[],
  discoveredFilesBySource: DiscoveredFilesBySource,
): number {
  let departedFileCount = 0;

  for (const storedFile of storedFiles) {
    const discoveredFiles = discoveredFilesBySource.get(storedFile.source.toLowerCase());

    if (!discoveredFiles) {
      continue;
    }

    if (!discoveredFiles.has(storedFile.filePath)) {
      departedFileCount += 1;
    }
  }

  return departedFileCount;
}

async function buildEventStoreDoctorResult(
  filePath: string,
  discoveredFilesBySource: DiscoveredFilesBySource,
  deps: DoctorDeps,
): Promise<DoctorSourceResult> {
  let fileStats: Awaited<ReturnType<typeof stat>>;

  try {
    fileStats = await stat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        id: 'event-store',
        format: 'sqlite',
        status: 'ok',
        itemsFound: 0,
        detail: 'not yet created',
      };
    }

    return {
      id: 'event-store',
      format: 'sqlite',
      status: 'error',
      error: getErrorReason(error),
    };
  }

  const readEventStoreSummary = deps.readEventStoreSummary ?? readDefaultEventStoreSummary;
  const readEventStoreStoredFiles =
    deps.readEventStoreStoredFiles ?? readDefaultEventStoreStoredFiles;

  try {
    const summary = await readEventStoreSummary(filePath);

    if (!isSupportedStoreSchemaVersion(summary.schemaVersion)) {
      return {
        id: 'event-store',
        format: 'sqlite',
        status: 'error',
        error: getUnsupportedSchemaError(summary.schemaVersion),
      };
    }

    const storedFiles = await readEventStoreStoredFiles(filePath);
    const departedFileCount = countDepartedFiles(storedFiles, discoveredFilesBySource);

    return {
      id: 'event-store',
      format: 'sqlite',
      status: 'ok',
      itemsFound: summary.eventCount,
      detail: [
        `${summary.eventCount} event(s)`,
        `${departedFileCount} departed file(s)`,
        `schema v${summary.schemaVersion ?? 'unknown'}`,
        formatByteSize(fileStats.size),
      ].join(', '),
    };
  } catch (error) {
    return {
      id: 'event-store',
      format: 'sqlite',
      status: 'error',
      error: getErrorReason(error),
    };
  }
}

const doctorStatusGlyphs = { ok: '✔', error: '✖' } as const;

function renderDoctorText(results: DoctorSourceResult[]): string {
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

export async function runDoctorReport(
  options: DoctorCommandOptions,
  deps: DoctorDeps = {},
): Promise<void> {
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const results = await buildDoctorResults(options, { ...deps, userConfigResolution });

  emitUserConfigResolution(userConfigResolution, logger);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ sources: results }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderDoctorText(results)}\n`);
}
