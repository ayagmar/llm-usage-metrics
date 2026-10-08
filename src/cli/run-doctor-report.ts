import { stat } from 'node:fs/promises';

import { getEventStoreRuntimeConfig } from '../config/runtime-overrides.js';
import {
  EVENT_STORE_SCHEMA_VERSION,
  findLegacyEventStore,
  isSupportedSchemaVersion,
  readEventStoreStoredFiles as readDefaultEventStoreStoredFiles,
  readEventStoreSummary as readDefaultEventStoreSummary,
  type EventStoreStoredFile,
  type EventStoreSummary,
} from '../persistence/event-store.js';
import {
  createDefaultAdapters,
  getSourceStorageFormat,
  type SourceStorageFormat,
} from '../sources/create-default-adapters.js';
import type { SourceAdapter } from '../sources/source-adapter.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { logger } from '../utils/logger.js';
import {
  resolveExplicitSourceIds,
  selectAdaptersBySourceFilter,
} from './build-usage-data-inputs.js';
import { resolveUserConfigForOptions, type UserConfigResolutionDeps } from './apply-user-config.js';
import { emitUserConfigResolution } from './emit-active-config.js';
import { formatByteSize } from '../render/format-byte-size.js';
import { renderDoctorText } from '../render/render-doctor-report.js';
import { describeMachineStatus } from '../render/render-machines.js';
import { getMachineCachePath, readMachineCacheStatus } from '../machines/machine-cache.js';
import type { MachineConfig } from '../config/user-config.js';
import { renderReportJson } from '../render/report-json.js';
import { prepareReport, runPreparedReport } from './report-runtime/report-lifecycle.js';
import type { DoctorCommandOptions } from './usage-data-contracts.js';
import { getErrorReason } from '../utils/get-error-reason.js';
import { hasErrorCode } from '../utils/error-code.js';

/**
 * found: files with readable usage. not_installed: no files in any searched path.
 * unparseable: files exist but the newest ones yield no usage (a log-format change, or
 * logs without usage yet). error: discovery itself failed.
 */
export type DoctorSourceState = 'found' | 'not_installed' | 'unparseable' | 'error';

export type DoctorSourceResult = {
  /** A source id, `event-store`, or `machine:<name>`. */
  id: string;
  format: SourceStorageFormat | 'ssh';
  /** Whether discovery ran; `state` says whether usage was found. */
  status: 'ok' | 'error';
  state?: DoctorSourceState;
  itemsFound?: number;
  detail?: string;
  error?: string;
  searchedPaths?: string[];
};

/** Newest files parsed when looking for usage; parsing stops at the first one with usage. */
const USAGE_PROBE_FILE_LIMIT = 25;

type UsageProbeResult = {
  usageFound: boolean;
  filesChecked: number;
  firstError?: string;
};

type DoctorDeps = UserConfigResolutionDeps & {
  getEventStoreRuntimeConfig?: typeof getEventStoreRuntimeConfig;
  readEventStoreStoredFiles?: (filePath: string) => Promise<EventStoreStoredFile[]>;
  readEventStoreSummary?: (filePath: string) => Promise<EventStoreSummary>;
  /** Epoch ms, for the machine rows' sync ages. */
  now?: () => number;
};

type DiscoveredFilesBySource = Map<string, Set<string>>;

async function sortNewestFirst(files: readonly string[]): Promise<string[]> {
  const mtimes = await Promise.all(
    files.map(async (filePath) => {
      try {
        return (await stat(filePath)).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );

  return files
    .map((filePath, index) => ({ filePath, mtimeMs: mtimes[index] }))
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || compareByCodePoint(left.filePath, right.filePath),
    )
    .map((entry) => entry.filePath);
}

async function parseFileEvents(adapter: SourceAdapter, filePath: string) {
  return adapter.parseFileWithDiagnostics
    ? (await adapter.parseFileWithDiagnostics(filePath)).events
    : adapter.parseFile(filePath);
}

async function probeForUsage(
  adapter: SourceAdapter,
  files: readonly string[],
): Promise<UsageProbeResult> {
  const candidates = (await sortNewestFirst(files)).slice(0, USAGE_PROBE_FILE_LIMIT);
  let firstError: string | undefined;

  for (const [index, filePath] of candidates.entries()) {
    try {
      if ((await parseFileEvents(adapter, filePath)).length > 0) {
        return { usageFound: true, filesChecked: index + 1 };
      }
    } catch (error) {
      firstError ??= getErrorReason(error);
    }
  }

  return { usageFound: false, filesChecked: candidates.length, firstError };
}

function describeMissingUsage(fileCount: number, probe: UsageProbeResult): string {
  const scope =
    probe.filesChecked === fileCount
      ? `${pluralize(fileCount, 'file')} found, none with readable usage`
      : `${pluralize(fileCount, 'file')} found, no readable usage in the newest ${probe.filesChecked}`;
  const reason = probe.firstError ? ` (${probe.firstError})` : '';

  return `${scope}${reason}; the log format may have changed`;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

async function buildSourceResult(
  adapter: SourceAdapter,
  hasPathOverride: boolean,
): Promise<{ result: DoctorSourceResult; files?: string[] }> {
  const format = getSourceStorageFormat(adapter.id.toLowerCase());
  const searchedPaths = [...(adapter.getSearchPaths?.() ?? [])];
  let files: string[];

  try {
    files = await adapter.discoverFiles();
  } catch (error) {
    return {
      result: {
        id: adapter.id,
        format,
        status: 'error',
        state: 'error',
        error: getErrorReason(error),
        searchedPaths,
      },
    };
  }

  const discovered = { id: adapter.id, format, status: 'ok' as const, itemsFound: files.length };

  if (files.length === 0) {
    // A path the user chose exists but holds nothing; "not installed" would mislead.
    const detail = hasPathOverride ? 'no files found in the given path' : undefined;
    return {
      result: {
        ...discovered,
        state: 'not_installed',
        ...(detail ? { detail } : {}),
        searchedPaths,
      },
      files,
    };
  }

  const probe = await probeForUsage(adapter, files);
  const result: DoctorSourceResult = probe.usageFound
    ? { ...discovered, state: 'found', searchedPaths }
    : {
        ...discovered,
        state: 'unparseable',
        detail: describeMissingUsage(files.length, probe),
        searchedPaths,
      };

  return { result, files };
}

export async function buildDoctorResults(
  options: DoctorCommandOptions,
  deps: DoctorDeps = {},
): Promise<DoctorSourceResult[]> {
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options;
  const adapters = selectAdaptersBySourceFilter(
    createDefaultAdapters(configuredOptions),
    configuredOptions.source,
  );
  // Doctor is the one caller that treats config sourceDirs as path overrides: it passes the
  // merged options on purpose, so an unreadable configured path surfaces as a doctor error.
  const sourcesWithPathOverrides = resolveExplicitSourceIds(configuredOptions, undefined);
  const results: DoctorSourceResult[] = [];
  const discoveredFilesBySource: DiscoveredFilesBySource = new Map();

  for (const adapter of adapters) {
    const { result, files } = await buildSourceResult(
      adapter,
      sourcesWithPathOverrides.has(adapter.id.toLowerCase()),
    );
    results.push(result);

    if (files) {
      discoveredFilesBySource.set(adapter.id.toLowerCase(), new Set(files));
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

  results.push(
    ...(await buildMachineDoctorResults(
      userConfigResolution.loadedConfig.config.machines ?? {},
      (deps.now ?? Date.now)(),
    )),
  );

  return results;
}

/** One row per configured machine, from its cache: doctor never connects over ssh. */
async function buildMachineDoctorResults(
  machines: Readonly<Record<string, MachineConfig>>,
  now: number,
): Promise<DoctorSourceResult[]> {
  return Promise.all(
    Object.entries(machines).map(async ([name, machine]): Promise<DoctorSourceResult> => {
      const id = `machine:${name}`;

      try {
        const status = await readMachineCacheStatus(name);
        const entry = {
          name,
          machine,
          state: status?.state,
          fileCount: status?.fileCount ?? 0,
          eventCount: status?.eventCount ?? 0,
        };
        const detail = `${machine.ssh}: ${describeMachineStatus(entry, now)}`;
        const { state } = entry;
        const lastSyncFailed =
          state?.lastError !== undefined && (state.attemptedAt ?? 0) >= (state.syncedAt ?? -1);

        return lastSyncFailed && machine.enabled !== false
          ? { id, format: 'ssh', status: 'error', itemsFound: entry.eventCount, error: detail }
          : { id, format: 'ssh', status: 'ok', itemsFound: entry.eventCount, detail };
      } catch (error) {
        return {
          id,
          format: 'ssh',
          status: 'error',
          error: `cannot read its cache at ${getMachineCachePath(name)}: ${getErrorReason(error)}`,
        };
      }
    }),
  );
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
    if (hasErrorCode(error, 'ENOENT')) {
      const legacyPath = await findLegacyEventStore(filePath);

      return {
        id: 'event-store',
        format: 'sqlite',
        status: 'ok',
        itemsFound: 0,
        detail:
          legacyPath === undefined
            ? 'not yet created'
            : `still at ${legacyPath}; the next report copies it here`,
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

    if (summary.schemaVersion === undefined || !isSupportedSchemaVersion(summary.schemaVersion)) {
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

export async function runDoctorReport(
  options: DoctorCommandOptions,
  deps: DoctorDeps = {},
): Promise<void> {
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const results = await buildDoctorResults(options, { ...deps, userConfigResolution });

  emitUserConfigResolution(userConfigResolution, logger);

  const preparedReport = await prepareReport({
    commandOptions: options,
    supportedFormats: ['terminal', 'json'] as const,
    buildData: async () => results,
    render: (data, format) =>
      format === 'json' ? renderReportJson('doctor', { sources: data }) : renderDoctorText(data),
    getDiagnostics: () => undefined,
  });
  await runPreparedReport({ preparedReport });
}
