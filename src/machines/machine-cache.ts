import { pluralize, toTerminalLine } from '@ayagmar/agent-sessions/internal';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  countFileEvents,
  deleteStoredFiles,
  getDefaultEventStorePath,
  listStoredFileFingerprints,
  openEventStore,
  readEventStoreEvents,
  readEventStoreMeta,
  readEventStoreMetaValues,
  readEventStoreStoredFiles,
  readEventStoreSummary,
  readStoredSessionEvents,
  replaceFilesEvents,
  runTransaction,
  writeEventStoreMeta,
  EventStoreSchemaVersionError,
  isSupportedSchemaVersion,
  type EventStore,
  type EventStoreFileFingerprint,
  type StoredSessionEvent,
  type StoredSessionEventKind,
} from '../persistence/event-store.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { pathExists } from '../utils/fs-helpers.js';
import { formatInteger } from '../render/format-number.js';
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

/**
 * Set by every sync of a version that stores tool calls and messages. A cache without it
 * may hold revisions whose tool calls an older version dropped, so it is not trusted.
 * Change its value when the reader starts keeping more (a new status, role or kind):
 * '2' also keeps usage events' message and request ids.
 */
const SESSION_EVENTS_KEPT_KEY = 'sessionEventsKept';
const SESSION_EVENTS_KEPT_VALUE = '2';

export type MachineSyncState = {
  hostname?: string;
  cliVersion?: string;
  /** Source id → parser version the last sync's export recorded; undefined if it did not. */
  parserVersions?: Record<string, string>;
  /** Git root → normalized remote the last sync's export recorded; undefined if it did not. */
  gitRemotes?: Record<string, string>;
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

function getMachineCacheDirectory(): string {
  return path.join(path.dirname(getDefaultEventStorePath()), 'machines');
}

export function getMachineCachePath(name: string): string {
  return path.join(getMachineCacheDirectory(), `${name}.db`);
}

/** Reports read a cache by date window, which this index serves. */
export async function openMachineCache(name: string): Promise<EventStore> {
  const cache = await openEventStore(getMachineCachePath(name));
  cache.database.exec('CREATE INDEX IF NOT EXISTS machine_events_timestamp ON events (timestamp)');
  return cache;
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

/** The files the cache holds and their revisions. */
function readCachedFiles(cache: EventStore): MachineExportFileKey[] {
  const files: MachineExportFileKey[] = [];

  for (const file of listStoredFileFingerprints(cache)) {
    const revision = readRevision(file.fingerprint);

    if (revision) {
      files.push([file.source, file.filePath, revision]);
    }
  }

  return files;
}

/**
 * The files to send as `machine export --known`: none when an older version last synced
 * the cache, so the next sync sends every file once with its tool calls and messages.
 */
export function readKnownFiles(cache: EventStore): MachineExportFileKey[] {
  return readEventStoreMeta(cache, SESSION_EVENTS_KEPT_KEY) === SESSION_EVENTS_KEPT_VALUE
    ? readCachedFiles(cache)
    : [];
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
        sessionEvents: file.sessionEvents,
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

      eventCount += countFileEvents(cache, source, filePath);
    }

    if (cachedRevisions.size !== bundle.files.length || eventCount !== bundle.eventCount) {
      throw new Error(
        `the cache holds ${pluralize(eventCount, 'event')} after the sync, but the export counts ${formatInteger(bundle.eventCount)}`,
      );
    }

    writeEventStoreMeta(cache, {
      hostname: bundle.header.hostname || undefined,
      cliVersion: bundle.header.cliVersion || undefined,
      parserVersions: bundle.header.parserVersions
        ? JSON.stringify(bundle.header.parserVersions)
        : undefined,
      gitRemotes: bundle.header.gitRemotes ? JSON.stringify(bundle.header.gitRemotes) : undefined,
      syncedAt: String(now),
      attemptedAt: String(now),
      lastError: undefined,
      [SESSION_EVENTS_KEPT_KEY]: SESSION_EVENTS_KEPT_VALUE,
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

/** The cache file can be edited or come from an older version: clean what reports print. */
function toStoredError(value: string | undefined): string | undefined {
  return value === undefined ? undefined : toTerminalLine(value);
}

function toEpochMs(value: string | undefined): number | undefined {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function toTextRecord(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return undefined;
  }
}

function toSyncState(readMeta: (key: string) => string | undefined): MachineSyncState {
  return {
    hostname: readMeta('hostname'),
    cliVersion: readMeta('cliVersion'),
    parserVersions: toTextRecord(readMeta('parserVersions')),
    gitRemotes: toTextRecord(readMeta('gitRemotes')),
    syncedAt: toEpochMs(readMeta('syncedAt')),
    attemptedAt: toEpochMs(readMeta('attemptedAt')),
    lastError: toStoredError(readMeta('lastError')),
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

/**
 * A machine's cached tool calls and messages of `kinds`, file by file in key order, read
 * without locking the cache. None when the machine was never synced, or its cache was last
 * synced by a version that kept none.
 */
export async function readMachineCacheSessionEvents(
  name: string,
  kinds: ReadonlySet<StoredSessionEventKind>,
): Promise<StoredSessionEvent[]> {
  const cachePath = getMachineCachePath(name);

  if (!(await pathExists(cachePath))) {
    return [];
  }

  try {
    const files = await readEventStoreStoredFiles(cachePath);
    return (await readStoredSessionEvents(cachePath, files, kinds)).flat();
  } catch (error) {
    // A cache synced before v5 is migrated by its next sync, which resends every file
    // (readKnownFiles); until then it has none.
    if (
      error instanceof EventStoreSchemaVersionError &&
      error.schemaVersion !== undefined &&
      isSupportedSchemaVersion(error.schemaVersion)
    ) {
      return [];
    }

    throw error;
  }
}

export type MachineCacheStatus = {
  state: MachineSyncState;
  fileCount: number;
  eventCount: number;
};

/**
 * The cache's sync state and size, or undefined when the machine was never synced. Read
 * read-only, so a sync in progress never blocks it.
 */
export async function readMachineCacheStatus(
  name: string,
): Promise<MachineCacheStatus | undefined> {
  const cachePath = getMachineCachePath(name);

  if (!(await pathExists(cachePath))) {
    return undefined;
  }

  const [meta, summary, storedFiles] = await Promise.all([
    readEventStoreMetaValues(cachePath),
    readEventStoreSummary(cachePath),
    readEventStoreStoredFiles(cachePath),
  ]);

  return {
    state: toSyncState((key) => meta.get(key)),
    fileCount: storedFiles.length,
    eventCount: summary.eventCount,
  };
}

/** The sync state, read without locking the cache; undefined when never synced. */
export async function readMachineSyncStateIfCached(
  name: string,
): Promise<MachineSyncState | undefined> {
  const cachePath = getMachineCachePath(name);

  if (!(await pathExists(cachePath))) {
    return undefined;
  }

  const meta = await readEventStoreMetaValues(cachePath);
  return toSyncState((key) => meta.get(key));
}

/** Whether the last sync, or attempt, is at least `intervalMs` old. */
export function isMachineSyncDue(
  state: MachineSyncState | undefined,
  now: number,
  intervalMs: number,
): boolean {
  const last = Math.max(state?.syncedAt ?? 0, state?.attemptedAt ?? 0);
  return now - last >= intervalMs;
}

/**
 * Records a sync attempt if one is due, in one transaction, so of several runs that find
 * the cache stale only one syncs it. False when another run got there first.
 */
export function claimMachineSync(cache: EventStore, now: number, intervalMs: number): boolean {
  return runTransaction(cache.database, () => {
    if (!isMachineSyncDue(readMachineSyncState(cache), now, intervalMs)) {
      return false;
    }

    writeEventStoreMeta(cache, { attemptedAt: String(now) });
    return true;
  });
}
