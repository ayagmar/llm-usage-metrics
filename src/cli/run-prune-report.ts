import { stat } from 'node:fs/promises';

import { getEventStoreRuntimeConfig } from '../config/runtime-overrides.js';
import {
  closeEventStore,
  findLegacyEventStore,
  deleteStoredFiles,
  openEventStore,
  runTransaction,
  vacuumEventStore,
  type DeleteStoredFilesResult,
  type EventStore,
} from '../persistence/event-store.js';
import {
  classifyDepartedFiles,
  type ClassifiedDepartedFile,
  type EventStoreHistoryDiscoveredFile,
} from '../persistence/event-store-history.js';
import { createDefaultAdapters } from '../sources/create-default-adapters.js';
import type { SourceAdapter } from '../sources/source-adapter.js';
import { renderPruneReport } from '../render/render-prune-report.js';
import { validateDateInput, selectAdaptersBySourceFilter } from './build-usage-data-inputs.js';
import { resolveUserConfigForOptions, type UserConfigResolutionDeps } from './apply-user-config.js';
import { emitUserConfigResolution } from './emit-active-config.js';
import { addStoredFilesStillOnDisk } from './history-live-files.js';
import { renderReportJson } from '../render/report-json.js';
import { prepareReport, runPreparedReport } from './report-runtime/report-lifecycle.js';
import { logger } from '../utils/logger.js';
import type { PruneCommandOptions } from './usage-data-contracts.js';
import { getErrorReason } from '../utils/get-error-reason.js';
import { hasErrorCode } from '../utils/error-code.js';

type StatFile = typeof stat;
type OpenStore = typeof openEventStore;
type CloseStore = typeof closeEventStore;

type PruneDeps = UserConfigResolutionDeps & {
  createAdapters?: (options: PruneCommandOptions) => SourceAdapter[];
  getEventStoreRuntimeConfig?: typeof getEventStoreRuntimeConfig;
  openEventStore?: OpenStore;
  closeEventStore?: CloseStore;
  statFile?: StatFile;
};

export type StoreSizeSnapshot = {
  databaseBytes: number;
  walBytes: number;
  shmBytes: number;
  totalBytes: number;
};

export type PruneCandidateReason = 'suppressed' | 'aged';

export type PruneCandidate = {
  source: string;
  filePath: string;
  eventCount: number;
  newestTimestamp?: string;
  reasons: PruneCandidateReason[];
};

export type PruneSummary = {
  storePath: string;
  applied: boolean;
  candidateFileCount: number;
  candidateEventCount: number;
  deletedFileCount?: number;
  deletedEventCount?: number;
  sizeBefore?: StoreSizeSnapshot;
  sizeAfter?: StoreSizeSnapshot;
  reclaimedBytes?: number;
};

export type PruneReportResult = {
  candidates: PruneCandidate[];
  summary: PruneSummary;
};

function assertHasSelector(options: PruneCommandOptions): void {
  if (options.suppressed || options.departedBefore !== undefined) {
    return;
  }

  throw new Error('prune requires at least one selector: --suppressed or --departed-before');
}

function parseDepartedBefore(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  validateDateInput(value, '--departed-before');
  return Date.parse(`${value}T00:00:00.000Z`);
}

function isOlderThanUtcDate(
  file: ClassifiedDepartedFile,
  departedBeforeTimestamp: number | undefined,
): boolean {
  if (departedBeforeTimestamp === undefined || file.newestTimestamp === undefined) {
    return false;
  }

  const newestTimestamp = Date.parse(file.newestTimestamp);

  return Number.isFinite(newestTimestamp) && newestTimestamp < departedBeforeTimestamp;
}

async function discoverLiveFiles(adapters: readonly SourceAdapter[]): Promise<{
  selectedSources: string[];
  discoveredFiles: EventStoreHistoryDiscoveredFile[];
}> {
  const selectedSources: string[] = [];
  const discoveredFiles: EventStoreHistoryDiscoveredFile[] = [];

  for (const adapter of adapters) {
    selectedSources.push(adapter.id);

    let files: string[];

    try {
      files = await adapter.discoverFiles();
    } catch (error) {
      throw new Error(
        `Cannot prune safely: ${adapter.id} discovery failed: ${getErrorReason(error)}`,
        { cause: error },
      );
    }

    discoveredFiles.push(
      ...files.map((filePath) => ({
        source: adapter.id,
        filePath,
      })),
    );
  }

  return { selectedSources, discoveredFiles };
}

function toCandidate(
  file: ClassifiedDepartedFile,
  options: {
    includeSuppressed: boolean;
    departedBeforeTimestamp: number | undefined;
  },
): PruneCandidate | undefined {
  const reasons: PruneCandidateReason[] = [];

  if (options.includeSuppressed && file.suppressed) {
    reasons.push('suppressed');
  }

  if (isOlderThanUtcDate(file, options.departedBeforeTimestamp)) {
    reasons.push('aged');
  }

  if (reasons.length === 0) {
    return undefined;
  }

  return {
    source: file.source,
    filePath: file.filePath,
    eventCount: file.eventCount,
    newestTimestamp: file.newestTimestamp,
    reasons,
  };
}

async function fileExists(filePath: string, statFile: StatFile): Promise<boolean> {
  try {
    await statFile(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }

    throw error;
  }
}

async function readFileSize(filePath: string, statFile: StatFile): Promise<number> {
  try {
    return (await statFile(filePath)).size;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return 0;
    }

    throw error;
  }
}

async function readStoreSizeSnapshot(
  filePath: string,
  statFile: StatFile,
): Promise<StoreSizeSnapshot> {
  const databaseBytes = await readFileSize(filePath, statFile);
  const walBytes = await readFileSize(`${filePath}-wal`, statFile);
  const shmBytes = await readFileSize(`${filePath}-shm`, statFile);

  return {
    databaseBytes,
    walBytes,
    shmBytes,
    totalBytes: databaseBytes + walBytes + shmBytes,
  };
}

function buildCandidates(
  files: readonly ClassifiedDepartedFile[],
  options: {
    includeSuppressed: boolean;
    departedBeforeTimestamp: number | undefined;
  },
): PruneCandidate[] {
  const candidates: PruneCandidate[] = [];

  for (const file of files) {
    const candidate = toCandidate(file, options);

    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function countCandidateEvents(candidates: readonly PruneCandidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidate.eventCount, 0);
}

function toDeleteResult(applied: boolean): DeleteStoredFilesResult | undefined {
  if (!applied) {
    return undefined;
  }

  return {
    deletedFileCount: 0,
    deletedEventCount: 0,
  };
}

async function withEventStore<T>(
  filePath: string,
  deps: Pick<PruneDeps, 'openEventStore' | 'closeEventStore'>,
  task: (store: EventStore) => T | Promise<T>,
): Promise<T> {
  const openStore = deps.openEventStore ?? openEventStore;
  const closeStore = deps.closeEventStore ?? closeEventStore;
  const store = await openStore(filePath);

  try {
    return await task(store);
  } finally {
    closeStore(store);
  }
}

export async function buildPruneReport(
  options: PruneCommandOptions,
  deps: PruneDeps = {},
): Promise<PruneReportResult> {
  assertHasSelector(options);
  const departedBeforeTimestamp = parseDepartedBefore(options.departedBefore);
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = {
    ...options,
    ...userConfigResolution.options,
  } satisfies PruneCommandOptions;
  const eventStoreRuntimeConfig = (deps.getEventStoreRuntimeConfig ?? getEventStoreRuntimeConfig)(
    process.env,
    userConfigResolution.loadedConfig.config,
  );

  if (!eventStoreRuntimeConfig.enabled) {
    throw new Error(
      eventStoreRuntimeConfig.disabledBy === 'environment'
        ? 'prune requires the event store (unset LLM_USAGE_EVENT_STORE=0)'
        : 'prune requires the event store (set eventStore.enabled = true in config.toml)',
    );
  }

  const makeAdapters = deps.createAdapters ?? createDefaultAdapters;
  const adapters = selectAdaptersBySourceFilter(
    makeAdapters(configuredOptions),
    configuredOptions.source,
  );
  const { selectedSources, discoveredFiles } = await discoverLiveFiles(adapters);
  const statFile = deps.statFile ?? stat;
  const storePath = eventStoreRuntimeConfig.path;

  // A ledger an older version left in the cache directory is copied in by withEventStore.
  if (
    !(await fileExists(storePath, statFile)) &&
    (await findLegacyEventStore(storePath)) === undefined
  ) {
    return {
      candidates: [],
      summary: {
        storePath,
        applied: Boolean(options.apply),
        candidateFileCount: 0,
        candidateEventCount: 0,
        ...toDeleteResult(Boolean(options.apply)),
      },
    };
  }

  return withEventStore(storePath, deps, async (store) => {
    const liveFiles = await addStoredFilesStillOnDisk(
      store,
      { selectedSources, discoveredFiles },
      { unverifiable: 'treat-as-live', statFile },
    );
    const selectCandidates = () =>
      buildCandidates(classifyDepartedFiles(store, liveFiles), {
        includeSuppressed: Boolean(options.suppressed),
        departedBeforeTimestamp,
      });

    if (!options.apply) {
      const candidates = selectCandidates();

      return {
        candidates,
        summary: {
          storePath,
          applied: false,
          candidateFileCount: candidates.length,
          candidateEventCount: countCandidateEvents(candidates),
        },
      };
    }

    const sizeBefore = await readStoreSizeSnapshot(storePath, statFile);
    // Select under the write lock, so a file a report re-ingested in the meantime is
    // judged by its current events, not deleted by an earlier look.
    const { candidates, deleteResult } = runTransaction(store.database, () => {
      const selected = selectCandidates();
      return { candidates: selected, deleteResult: deleteStoredFiles(store, selected) };
    });
    const candidateEventCount = countCandidateEvents(candidates);
    vacuumEventStore(store);
    store.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const sizeAfter = await readStoreSizeSnapshot(storePath, statFile);

    return {
      candidates,
      summary: {
        storePath,
        applied: true,
        candidateFileCount: candidates.length,
        candidateEventCount,
        deletedFileCount: deleteResult.deletedFileCount,
        deletedEventCount: deleteResult.deletedEventCount,
        sizeBefore,
        sizeAfter,
        reclaimedBytes: Math.max(0, sizeBefore.totalBytes - sizeAfter.totalBytes),
      },
    };
  });
}

export async function runPruneReport(
  options: PruneCommandOptions,
  deps: PruneDeps = {},
): Promise<void> {
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const result = await buildPruneReport(options, { ...deps, userConfigResolution });

  emitUserConfigResolution(userConfigResolution, logger);

  const preparedReport = await prepareReport({
    commandOptions: options,
    supportedFormats: ['terminal', 'json'] as const,
    buildData: async () => result,
    render: (data, format) =>
      format === 'json'
        ? renderReportJson('prune', { candidates: data.candidates, summary: data.summary })
        : renderPruneReport(data),
    getDiagnostics: () => undefined,
  });
  await runPreparedReport({ preparedReport });
}
