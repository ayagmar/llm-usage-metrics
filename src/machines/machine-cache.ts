import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  closeEventStore,
  countEvents,
  deleteStoredFiles,
  getDefaultEventStorePath,
  listStoredFileFingerprints,
  openEventStore,
  readEventStoreEvents,
  readEventStoreMeta,
  replaceFilesEvents,
  runTransaction,
  writeEventStoreMeta,
  type EventStore,
  type EventStoreFileFingerprint,
} from '../persistence/event-store.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { pathExists } from '../utils/fs-helpers.js';
import {
  toFileKey,
  type MachineExportFileKey,
  type ParsedMachineExport,
} from './machine-export-bundle.js';

/**
 * A machine's synced usage lives in its own event store, so the local ledger never mixes
 * with another machine's files. A cached file's revision is kept in its fingerprint.
 */
const REVISION_PREFIX = 'machine-export:';

export type MachineSyncState = {
  hostname?: string;
  cliVersion?: string;
  /** Epoch ms of the last successful sync. */
  syncedAt?: number;
  /** Epoch ms of the last sync attempt, successful or not. */
  attemptedAt?: number;
  /** Why the last attempt failed; cleared by a successful sync. */
  lastError?: string;
};

export type MachineSyncResult = {
  receivedFileCount: number;
  removedFileCount: number;
  fileCount: number;
  eventCount: number;
};

export function getMachineCacheDirectory(): string {
  return path.join(path.dirname(getDefaultEventStorePath()), 'machines');
}

export function getMachineCachePath(name: string): string {
  return path.join(getMachineCacheDirectory(), `${name}.db`);
}

export function openMachineCache(name: string): Promise<EventStore> {
  return openEventStore(getMachineCachePath(name));
}

export async function deleteMachineCache(name: string): Promise<void> {
  const cachePath = getMachineCachePath(name);

  for (const filePath of [cachePath, `${cachePath}-wal`, `${cachePath}-shm`]) {
    await rm(filePath, { force: true });
  }
}

function toRevisionFingerprint(filePath: string, revision: string): EventStoreFileFingerprint {
  return {
    parserVersion: `${REVISION_PREFIX}${revision}`,
    dependencies: [{ path: filePath, exists: false }],
  };
}

function readRevision(fingerprint: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(fingerprint);
    const parserVersion =
      typeof parsed === 'object' && parsed !== null && 'parserVersion' in parsed
        ? parsed.parserVersion
        : undefined;

    return typeof parserVersion === 'string' && parserVersion.startsWith(REVISION_PREFIX)
      ? parserVersion.slice(REVISION_PREFIX.length)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The files the cache holds, to send as `machine export --known`. */
export function readCachedFiles(cache: EventStore): MachineExportFileKey[] {
  const files: MachineExportFileKey[] = [];

  for (const file of listStoredFileFingerprints(cache)) {
    const revision = readRevision(file.fingerprint);

    if (revision) {
      files.push([file.source, file.filePath, revision]);
    }
  }

  return files;
}

function countCachedEvents(cache: EventStore, source: string, filePath: string): number {
  const row = cache.database
    .prepare('SELECT COUNT(*) AS count FROM events WHERE source = ? AND file_path = ?')
    .get(source, filePath);
  return typeof row?.count === 'number' ? row.count : 0;
}

/**
 * Applies a complete export in one transaction: stores the sent files, removes the files
 * the export no longer lists, and checks that the cache then holds exactly the listed
 * files and event count. On any mismatch nothing changes.
 */
export function applyMachineExport(
  cache: EventStore,
  bundle: ParsedMachineExport,
  now: number,
): MachineSyncResult {
  return runTransaction(cache.database, () => {
    const listedKeys = new Set(
      bundle.files.map(([source, filePath]) => toFileKey(source, filePath)),
    );
    const staleFiles = readCachedFiles(cache).filter(
      ([source, filePath]) => !listedKeys.has(toFileKey(source, filePath)),
    );

    deleteStoredFiles(
      cache,
      staleFiles.map(([source, filePath]) => ({ source, filePath })),
    );
    replaceFilesEvents(
      cache,
      bundle.sentFiles.map((file) => ({
        source: file.source,
        filePath: file.filePath,
        fingerprint: toRevisionFingerprint(file.filePath, file.revision),
        events: file.events,
        skippedRows: 0,
        now,
      })),
    );

    const cachedRevisions = new Map(
      readCachedFiles(cache).map(([source, filePath, revision]) => [
        toFileKey(source, filePath),
        revision,
      ]),
    );
    let eventCount = 0;

    for (const [source, filePath, revision] of bundle.files) {
      if (cachedRevisions.get(toFileKey(source, filePath)) !== revision) {
        throw new Error(`the export skipped ${filePath}, which the cache does not hold`);
      }

      eventCount += countCachedEvents(cache, source, filePath);
    }

    if (cachedRevisions.size !== bundle.files.length || eventCount !== bundle.eventCount) {
      throw new Error(
        `the cache holds ${eventCount} event(s) after the sync, but the export counts ${bundle.eventCount}`,
      );
    }

    writeEventStoreMeta(cache, {
      hostname: bundle.header.hostname || undefined,
      cliVersion: bundle.header.cliVersion || undefined,
      syncedAt: String(now),
      attemptedAt: String(now),
      lastError: undefined,
    });

    return {
      receivedFileCount: bundle.sentFiles.length,
      removedFileCount: staleFiles.length,
      fileCount: bundle.files.length,
      eventCount,
    };
  });
}

export function recordMachineSyncFailure(cache: EventStore, reason: string, now: number): void {
  writeEventStoreMeta(cache, { attemptedAt: String(now), lastError: reason });
}

function toEpochMs(value: string | undefined): number | undefined {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function toSyncState(readMeta: (key: string) => string | undefined): MachineSyncState {
  return {
    hostname: readMeta('hostname'),
    cliVersion: readMeta('cliVersion'),
    syncedAt: toEpochMs(readMeta('syncedAt')),
    attemptedAt: toEpochMs(readMeta('attemptedAt')),
    lastError: readMeta('lastError'),
  };
}

export function readMachineSyncState(cache: EventStore): MachineSyncState {
  return toSyncState((key) => readEventStoreMeta(cache, key));
}

export type MachineCacheUsage = {
  state: MachineSyncState;
  events: UsageEvent[];
};

/**
 * A machine's cached events in a timestamp window and its sync state, read without
 * locking the cache; undefined when the machine was never synced.
 */
export async function readMachineCacheUsage(
  name: string,
  window: { fromTimestamp?: string; toTimestamp?: string },
): Promise<MachineCacheUsage | undefined> {
  const cachePath = getMachineCachePath(name);

  if (!(await pathExists(cachePath))) {
    return undefined;
  }

  const { meta, events } = await readEventStoreEvents(cachePath, window);
  return { state: toSyncState((key) => meta.get(key)), events };
}

export type MachineCacheStatus = {
  state: MachineSyncState;
  fileCount: number;
  eventCount: number;
};

/** The cache's sync state and size, or undefined when the machine was never synced. */
export async function readMachineCacheStatus(
  name: string,
): Promise<MachineCacheStatus | undefined> {
  if (!(await pathExists(getMachineCachePath(name)))) {
    return undefined;
  }

  const cache = await openMachineCache(name);

  try {
    return {
      state: readMachineSyncState(cache),
      fileCount: readCachedFiles(cache).length,
      eventCount: countEvents(cache),
    };
  } finally {
    closeEventStore(cache);
  }
}
