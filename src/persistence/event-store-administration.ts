import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeSkippedRowReasons } from '../cli/normalize-skipped-row-reasons.js';
import { createUsageEvent, normalizeSourceId, type UsageEvent } from '../domain/usage-event.js';
import { loadNodeSqliteModule } from '../sources/opencode/node-sqlite-loader.js';
import type { SourceSkippedRowReasonStat } from '../sources/source-adapter.js';
import { getUserCacheRootDir } from '../utils/cache-root-dir.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getUserDataRootDir } from '../utils/data-root-dir.js';
import { ensureDirectory, pathExists, pathStat } from '../utils/fs-helpers.js';
import {
  computeEventContentHash,
  normalizeStoredEventTuple,
  type StoredEventTuple,
} from './event-store-codec.js';
import {
  type EventStore,
  type EventStoreDatabase,
  type EventStoreSqliteModule,
  isEventStoreSqliteModule,
  type LoadEventStoreSqliteModule,
  runTransaction,
  toNonNegativeInteger,
  toNonNegativeNumber,
  toText,
} from './event-store-database.js';
import { takeUncountedEvents } from './event-store-history.js';
import {
  assertSupportedSchemaVersion,
  EVENT_STORE_SCHEMA_VERSION,
  initializeSchema,
} from './event-store-schema.js';
import { hasErrorCode } from '../utils/error-code.js';

const EVENT_STORE_OPEN_TIMEOUT_MS = 2_000;

const loadEventStoreSqliteModule: LoadEventStoreSqliteModule = () =>
  loadNodeSqliteModule('Event store');

export type EventStoreDependencyFingerprint = {
  path: string;
  exists: boolean;
  size?: number;
  mtimeMs?: number;
};

export type EventStoreFileFingerprint = {
  /** Identifies the parser that produced the stored events; a change forces a re-parse. */
  parserVersion?: string;
  dependencies: EventStoreDependencyFingerprint[];
};

export type EventStoreFileEntry = {
  fingerprint: string;
  skippedRows: number;
  skippedRowReasons: SourceSkippedRowReasonStat[];
};

export type ReplaceFileEventsInput = {
  source: string;
  filePath: string;
  fingerprint: EventStoreFileFingerprint;
  events: UsageEvent[];
  skippedRows: number;
  skippedRowReasons?: SourceSkippedRowReasonStat[];
  now: number;
};

export type DeleteStoredFilesInput = {
  source: string;
  filePath: string;
};

export type DeleteStoredFilesResult = {
  deletedFileCount: number;
  deletedEventCount: number;
};

export type EventStoreSummary = {
  eventCount: number;
  schemaVersion?: string;
};

export type EventStoreStoredFile = {
  source: string;
  filePath: string;
};

export type EventStoreFileSnapshot = EventStoreStoredFile & {
  /** A digest of `events`: it changes exactly when they do. */
  revision: string;
  events: UsageEvent[];
};

function normalizeStoreSource(source: string): string {
  const normalizedSource = normalizeSourceId(source)?.toLowerCase();

  if (!normalizedSource) {
    throw new Error('Event store source must be a non-empty string');
  }

  return normalizedSource;
}

function normalizeStoreFilePath(filePath: string): string {
  const normalizedFilePath = filePath.trim();

  if (!normalizedFilePath) {
    throw new Error('Event store file path must be a non-empty string');
  }

  return normalizedFilePath;
}

function normalizeDependencyFingerprint(
  value: EventStoreDependencyFingerprint,
): EventStoreDependencyFingerprint | undefined {
  const dependencyPath = toText(value.path);

  if (!dependencyPath) {
    return undefined;
  }

  if (!value.exists) {
    return {
      path: dependencyPath,
      exists: false,
    };
  }

  const size = toNonNegativeInteger(value.size);
  const mtimeMs = toNonNegativeNumber(value.mtimeMs);

  if (size === undefined || mtimeMs === undefined) {
    return undefined;
  }

  return {
    path: dependencyPath,
    exists: true,
    size,
    mtimeMs,
  };
}

function compareDependencyFingerprint(
  left: EventStoreDependencyFingerprint,
  right: EventStoreDependencyFingerprint,
): number {
  if (left.path !== right.path) {
    return compareByCodePoint(left.path, right.path);
  }

  if (left.exists !== right.exists) {
    return left.exists ? 1 : -1;
  }

  if ((left.size ?? -1) !== (right.size ?? -1)) {
    return (left.size ?? -1) - (right.size ?? -1);
  }

  return (left.mtimeMs ?? -1) - (right.mtimeMs ?? -1);
}

function normalizeEventStoreFingerprint(
  fingerprint: EventStoreFileFingerprint,
): EventStoreFileFingerprint | undefined {
  if (!Array.isArray(fingerprint.dependencies) || fingerprint.dependencies.length === 0) {
    return undefined;
  }

  const dependencies: EventStoreDependencyFingerprint[] = [];

  for (const dependency of fingerprint.dependencies) {
    const normalizedDependency = normalizeDependencyFingerprint(dependency);

    if (!normalizedDependency) {
      return undefined;
    }

    dependencies.push(normalizedDependency);
  }

  dependencies.sort(compareDependencyFingerprint);

  const parserVersion = toText(fingerprint.parserVersion);

  return parserVersion ? { parserVersion, dependencies } : { dependencies };
}

export function serializeEventStoreFingerprint(fingerprint: EventStoreFileFingerprint): string {
  const normalizedFingerprint = normalizeEventStoreFingerprint(fingerprint);

  if (!normalizedFingerprint) {
    throw new Error('Event store fingerprint must include valid dependency fingerprints');
  }

  return JSON.stringify(normalizedFingerprint);
}

function parseSkippedRowReasons(value: unknown): SourceSkippedRowReasonStat[] {
  if (typeof value !== 'string') {
    return [];
  }

  try {
    return normalizeSkippedRowReasons(JSON.parse(value));
  } catch {
    return [];
  }
}

function stringifySkippedRowReasons(
  skippedRowReasons: SourceSkippedRowReasonStat[] | undefined,
): string | null {
  const normalizedReasons = normalizeSkippedRowReasons(skippedRowReasons);
  return normalizedReasons.length > 0 ? JSON.stringify(normalizedReasons) : null;
}

export function getDefaultEventStorePath(): string {
  return path.join(getUserDataRootDir(), 'llm-usage-metrics', 'events.db');
}

/** Older versions kept the ledger in the cache directory, which users and tools clear freely. */
export function getLegacyEventStorePath(): string {
  return path.join(getUserCacheRootDir(), 'llm-usage-metrics', 'events.db');
}

/**
 * Written next to the ledger once the legacy copy succeeds, so deleting the ledger later
 * (a reset) never re-imports the old copy and its already-pruned history.
 */
function getLegacyCopyMarkerPath(targetPath: string): string {
  return path.join(path.dirname(targetPath), 'legacy-ledger-copied');
}

/**
 * The cache-directory ledger an older version left, when the default ledger does not exist
 * yet and has never been copied from it.
 */
export async function findLegacyEventStore(targetPath: string): Promise<string | undefined> {
  const legacyPath = getLegacyEventStorePath();

  if (
    targetPath !== getDefaultEventStorePath() ||
    legacyPath === targetPath ||
    (await pathExists(targetPath)) ||
    (await pathExists(getLegacyCopyMarkerPath(targetPath))) ||
    !(await pathExists(legacyPath))
  ) {
    return undefined;
  }

  return legacyPath;
}

/**
 * Copies a ledger left by an older version to `targetPath` once. VACUUM INTO takes a
 * consistent snapshot that includes uncheckpointed WAL pages and works across filesystems;
 * the snapshot is hard-linked into place, so a concurrent first run can never overwrite
 * the other's. The old ledger stays: an older version may still be writing to it.
 */
async function copyLegacyEventStore(
  targetPath: string,
  sqliteModule: EventStoreSqliteModule,
): Promise<void> {
  const legacyPath = getLegacyEventStorePath();
  const markerPath = getLegacyCopyMarkerPath(targetPath);

  if (
    targetPath !== getDefaultEventStorePath() ||
    legacyPath === targetPath ||
    (await pathExists(markerPath)) ||
    !(await pathExists(legacyPath))
  ) {
    return;
  }

  if (!(await pathExists(targetPath))) {
    const snapshotPath = `${targetPath}.${randomUUID()}.tmp`;

    try {
      const legacyDatabase = new sqliteModule.DatabaseSync(legacyPath, {
        timeout: EVENT_STORE_OPEN_TIMEOUT_MS,
      });

      try {
        legacyDatabase.prepare('VACUUM INTO ?').run(snapshotPath);
      } finally {
        legacyDatabase.close();
      }

      try {
        await link(snapshotPath, targetPath);
      } catch (error) {
        // Another first run copied the ledger while this one did.
        if (!hasErrorCode(error, 'EEXIST')) {
          throw error;
        }
      }
    } finally {
      await rm(snapshotPath, { force: true });
    }
  }

  // The ledger exists now, copied or not (a run may have stopped before marking its copy):
  // the old one must never be imported later.
  await writeFile(markerPath, `${legacyPath}\n`, { mode: 0o600 });
}

async function prepareEventStoreFile(filePath: string): Promise<void> {
  // Opening a FIFO or device blocks or misbehaves; only a regular file (or none yet) is a ledger.
  const existing = await pathStat(filePath);

  if (existing && !existing.isFile()) {
    throw new Error(`Event store path ${filePath} is not a regular file`);
  }

  const fileHandle = await open(filePath, 'a', 0o600);

  try {
    await chmod(filePath, 0o600);
  } finally {
    await fileHandle.close();
  }
}

async function restrictEventStoreFiles(filePath: string): Promise<void> {
  await chmod(filePath, 0o600);

  for (const sidecarPath of [`${filePath}-wal`, `${filePath}-shm`]) {
    try {
      await chmod(sidecarPath, 0o600);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        continue;
      }

      throw error;
    }
  }
}

export async function openEventStore(
  filePath: string = getDefaultEventStorePath(),
  loadSqliteModule: LoadEventStoreSqliteModule = loadEventStoreSqliteModule,
): Promise<EventStore> {
  const parentDirectory = path.dirname(filePath);
  await ensureDirectory(parentDirectory, 0o700);

  if (filePath === getDefaultEventStorePath()) {
    await chmod(parentDirectory, 0o700);
  }

  const sqliteModule = await loadSqliteModule();

  if (!isEventStoreSqliteModule(sqliteModule)) {
    throw new Error('Event store requires a sqlite module with a DatabaseSync constructor');
  }

  await copyLegacyEventStore(filePath, sqliteModule);

  await prepareEventStoreFile(filePath);

  const database = new sqliteModule.DatabaseSync(filePath, {
    timeout: EVENT_STORE_OPEN_TIMEOUT_MS,
  });

  try {
    assertSupportedSchemaVersion(database);
    database.exec('PRAGMA journal_mode=WAL');

    // In WAL mode NORMAL skips the fsync on every commit but keeps the database
    // consistent; a power loss can only drop the latest commits, which the next run
    // re-parses from the source files. A rollback journal keeps the safer default.
    if (toText(database.prepare('PRAGMA journal_mode').get()?.journal_mode) === 'wal') {
      database.exec('PRAGMA synchronous=NORMAL');
    }
    initializeSchema(database);
    await restrictEventStoreFiles(filePath);

    return {
      database,
      filePath,
      statements: {},
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function readEventStoreSummary(
  filePath: string = getDefaultEventStorePath(),
  loadSqliteModule: LoadEventStoreSqliteModule = loadEventStoreSqliteModule,
): Promise<EventStoreSummary> {
  const sqliteModule = await loadSqliteModule();

  if (!isEventStoreSqliteModule(sqliteModule)) {
    throw new Error('Event store requires a sqlite module with a DatabaseSync constructor');
  }

  const database = new sqliteModule.DatabaseSync(filePath, {
    readOnly: true,
    timeout: EVENT_STORE_OPEN_TIMEOUT_MS,
  });

  try {
    const schemaVersionRow = database
      .prepare("SELECT value FROM meta WHERE key = 'schemaVersion'")
      .get();
    const countRow = database.prepare('SELECT COUNT(*) AS count FROM events').get();

    return {
      eventCount: toNonNegativeInteger(countRow?.count) ?? 0,
      schemaVersion: toText(schemaVersionRow?.value),
    };
  } finally {
    database.close();
  }
}

export async function readEventStoreStoredFiles(
  filePath: string = getDefaultEventStorePath(),
  loadSqliteModule: LoadEventStoreSqliteModule = loadEventStoreSqliteModule,
): Promise<EventStoreStoredFile[]> {
  const sqliteModule = await loadSqliteModule();

  if (!isEventStoreSqliteModule(sqliteModule)) {
    throw new Error('Event store requires a sqlite module with a DatabaseSync constructor');
  }

  const database = new sqliteModule.DatabaseSync(filePath, {
    readOnly: true,
    timeout: EVENT_STORE_OPEN_TIMEOUT_MS,
  });

  try {
    const rows = database
      .prepare(
        ['SELECT source, file_path', 'FROM files', 'ORDER BY source ASC, file_path ASC'].join('\n'),
      )
      .all();
    const files: EventStoreStoredFile[] = [];

    for (const row of rows) {
      const source = toText(row.source);
      const filePath = toText(row.file_path);

      if (!source || !filePath) {
        continue;
      }

      files.push({ source, filePath });
    }

    return files;
  } finally {
    database.close();
  }
}

/** Every stored file with its raw fingerprint, in key order. */
export function listStoredFileFingerprints(
  store: EventStore,
): (EventStoreStoredFile & { fingerprint: string })[] {
  const rows = store.database
    .prepare('SELECT source, file_path, fingerprint FROM files ORDER BY source ASC, file_path ASC')
    .all();
  const files: (EventStoreStoredFile & { fingerprint: string })[] = [];

  for (const row of rows) {
    const source = toText(row.source);
    const filePath = toText(row.file_path);
    const fingerprint = toText(row.fingerprint);

    if (source && filePath && fingerprint) {
      files.push({ source, filePath, fingerprint });
    }
  }

  return files;
}

export function readEventStoreMeta(store: EventStore, key: string): string | undefined {
  return toText(store.database.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value);
}

/** Sets meta values; `undefined` deletes the key. */
export function writeEventStoreMeta(
  store: EventStore,
  entries: Readonly<Record<string, string | undefined>>,
): void {
  runTransaction(store.database, () => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) {
        store.database.prepare('DELETE FROM meta WHERE key = ?').run(key);
      } else {
        store.database
          .prepare(
            'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          )
          .run(key, value);
      }
    }
  });
}

/** The meta table of a store, opened read-only so a writer never blocks the read. */
export async function readEventStoreMetaValues(
  filePath: string,
  loadSqliteModule: LoadEventStoreSqliteModule = loadEventStoreSqliteModule,
): Promise<Map<string, string>> {
  const sqliteModule = await loadSqliteModule();

  if (!isEventStoreSqliteModule(sqliteModule)) {
    throw new Error('Event store requires a sqlite module with a DatabaseSync constructor');
  }

  const database = new sqliteModule.DatabaseSync(filePath, {
    readOnly: true,
    timeout: EVENT_STORE_OPEN_TIMEOUT_MS,
  });

  try {
    return readMetaValues(database);
  } finally {
    database.close();
  }
}

function readMetaValues(database: EventStoreDatabase): Map<string, string> {
  const meta = new Map<string, string>();

  for (const row of database.prepare('SELECT key, value FROM meta').all()) {
    const key = toText(row.key);
    const value = toText(row.value);

    if (key && value) {
      meta.set(key, value);
    }
  }

  return meta;
}

/**
 * Reads the meta table and every stored event, optionally only those with
 * `fromTimestamp <= timestamp < toTimestamp` (ISO strings), from a store opened
 * read-only, so a writer holding the store never blocks it. Invalid rows are skipped.
 */
export async function readEventStoreEvents(
  filePath: string,
  window: { fromTimestamp?: string; toTimestamp?: string } = {},
  loadSqliteModule: LoadEventStoreSqliteModule = loadEventStoreSqliteModule,
): Promise<{ meta: Map<string, string>; events: UsageEvent[] }> {
  const sqliteModule = await loadSqliteModule();

  if (!isEventStoreSqliteModule(sqliteModule)) {
    throw new Error('Event store requires a sqlite module with a DatabaseSync constructor');
  }

  const database = new sqliteModule.DatabaseSync(filePath, {
    readOnly: true,
    timeout: EVENT_STORE_OPEN_TIMEOUT_MS,
  });

  try {
    assertSupportedSchemaVersion(database);
    const meta = readMetaValues(database);
    // A read-only open cannot migrate, and stores older than v4 lack the one-hour column.
    const cacheWrite1hColumn =
      meta.get('schemaVersion') === EVENT_STORE_SCHEMA_VERSION
        ? 'cache_write_1h_tokens'
        : '0 AS cache_write_1h_tokens';
    const statement = database.prepare(
      [
        'SELECT source, session_id, timestamp, model, provider, repo_root,',
        '  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,',
        `  cache_write_tokens, ${cacheWrite1hColumn}, total_tokens, cost_usd, cost_mode`,
        'FROM events',
        'WHERE timestamp >= ? AND timestamp < ?',
        'ORDER BY source, file_path, event_index',
      ].join('\n'),
    );
    statement.setReturnArrays(true);
    // StatementSync's return type does not narrow after setReturnArrays(true).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const rows = statement.all(
      window.fromTimestamp ?? '',
      window.toTimestamp ?? '\uFFFF',
    ) as unknown as StoredEventTuple[];
    const events: UsageEvent[] = [];

    for (const row of rows) {
      const event = normalizeStoredEventTuple(row);

      if (event) {
        events.push(event);
      }
    }

    return { meta, events };
  } finally {
    database.close();
  }
}

function deleteFileEntry(store: EventStore, source: string, filePath: string): void {
  deleteStoredFiles(store, [{ source, filePath }]);
}

export function getFileEntry(
  store: EventStore,
  source: string,
  filePath: string,
): EventStoreFileEntry | undefined {
  const normalizedSource = normalizeStoreSource(source);
  const normalizedFilePath = normalizeStoreFilePath(filePath);
  const statement = (store.statements.getFileEntry ??= store.database.prepare(
    [
      'SELECT fingerprint, skipped_rows, skipped_row_reasons',
      'FROM files',
      'WHERE source = ? AND file_path = ?',
    ].join('\n'),
  ));
  const row = statement.get(normalizedSource, normalizedFilePath);

  if (!row) {
    return undefined;
  }

  const fingerprint = toText(row.fingerprint);
  const skippedRows = toNonNegativeInteger(row.skipped_rows);

  if (!fingerprint || skippedRows === undefined) {
    deleteFileEntry(store, normalizedSource, normalizedFilePath);
    return undefined;
  }

  return {
    fingerprint,
    skippedRows,
    skippedRowReasons: parseSkippedRowReasons(row.skipped_row_reasons),
  };
}

function selectFileEventRows(
  store: EventStore,
  source: string,
  filePath: string,
): StoredEventTuple[] {
  let statement = store.statements.selectFileEvents;

  if (!statement) {
    statement = store.database.prepare(
      [
        'SELECT source, session_id, timestamp, model, provider, repo_root,',
        '  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,',
        '  cache_write_tokens, cache_write_1h_tokens, total_tokens, cost_usd, cost_mode',
        'FROM events',
        'WHERE source = ? AND file_path = ?',
        'ORDER BY event_index ASC',
      ].join('\n'),
    );
    statement.setReturnArrays(true);
    store.statements.selectFileEvents = statement;
  }

  // StatementSync's return type does not narrow after setReturnArrays(true).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return statement.all(source, filePath) as unknown as StoredEventTuple[];
}

export function readFileEvents(
  store: EventStore,
  source: string,
  filePath: string,
): UsageEvent[] | undefined {
  const normalizedSource = normalizeStoreSource(source);
  const normalizedFilePath = normalizeStoreFilePath(filePath);
  const events: UsageEvent[] = [];

  for (const row of selectFileEventRows(store, normalizedSource, normalizedFilePath)) {
    const event = normalizeStoredEventTuple(row);

    if (!event) {
      deleteFileEntry(store, normalizedSource, normalizedFilePath);
      return undefined;
    }

    events.push(event);
  }

  return events;
}

export function readDepartedFileEvents(
  store: EventStore,
  source: string,
  filePath: string,
): UsageEvent[] {
  const normalizedSource = normalizeStoreSource(source);
  const normalizedFilePath = normalizeStoreFilePath(filePath);
  const events: UsageEvent[] = [];

  for (const row of selectFileEventRows(store, normalizedSource, normalizedFilePath)) {
    const event = normalizeStoredEventTuple(row);

    // A departed file has no source data left to re-parse, so an invalid row
    // is skipped instead of deleting the ledger's only copy of the file.
    if (!event) {
      continue;
    }

    events.push(event);
  }

  return events;
}

/**
 * Reads the stored events of `files`, then of the departed `historyFiles`, in one read
 * transaction, so a concurrent run that rewrites a file cannot be seen half-written. As
 * reports do, a history file, or a file of a source in `repeatingSources` (see
 * `eventsRepeatAcrossFiles`), is read without the events the files before it already
 * hold, decided on this same snapshot. A file's revision is a digest of the events read,
 * so it changes exactly when they do. Invalid rows are skipped, as for history; a file
 * the store does not hold has no events.
 */
export function readStoredFileSnapshots(
  store: EventStore,
  files: readonly EventStoreStoredFile[],
  options: {
    historyFiles?: readonly EventStoreStoredFile[];
    repeatingSources?: ReadonlySet<string>;
  } = {},
): EventStoreFileSnapshot[] {
  const historyFiles = options.historyFiles ?? [];
  const repeatingSources = options.repeatingSources ?? new Set<string>();
  const snapshots: EventStoreFileSnapshot[] = [];
  const countedHashes = new Map<string, number>();
  const readSnapshot = (
    file: EventStoreStoredFile,
    selectEvents: (events: UsageEvent[]) => UsageEvent[],
  ): void => {
    const source = normalizeStoreSource(file.source);
    const filePath = normalizeStoreFilePath(file.filePath);
    const events = selectEvents(readDepartedFileEvents(store, source, filePath));

    snapshots.push({
      source,
      filePath,
      revision: createHash('sha256').update(JSON.stringify(events)).digest('hex').slice(0, 16),
      events,
    });
  };

  // A read snapshot, not runTransaction's write lock; so never call this inside one.
  store.database.exec('BEGIN');

  try {
    for (const file of files) {
      readSnapshot(file, (events) => {
        if (repeatingSources.has(normalizeStoreSource(file.source))) {
          return takeUncountedEvents(events, countedHashes);
        }

        if (historyFiles.length > 0) {
          for (const event of events) {
            const hash = computeEventContentHash(event);
            countedHashes.set(hash, (countedHashes.get(hash) ?? 0) + 1);
          }
        }

        return events;
      });
    }

    for (const file of historyFiles) {
      readSnapshot(file, (events) => takeUncountedEvents(events, countedHashes));
    }
  } finally {
    store.database.exec('COMMIT');
  }

  return snapshots;
}

function countMatchingRows(
  store: EventStore,
  tableName: 'events' | 'files',
  source: string,
  filePath: string,
): number {
  const row = store.database
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE source = ? AND file_path = ?`)
    .get(source, filePath);
  return toNonNegativeInteger(row?.count) ?? 0;
}

export function deleteStoredFiles(
  store: EventStore,
  files: readonly DeleteStoredFilesInput[],
): DeleteStoredFilesResult {
  const normalizedFiles = files.map((file) => ({
    source: normalizeStoreSource(file.source),
    filePath: normalizeStoreFilePath(file.filePath),
  }));
  const result: DeleteStoredFilesResult = {
    deletedFileCount: 0,
    deletedEventCount: 0,
  };

  runTransaction(store.database, () => {
    const deleteEvents = store.database.prepare(
      'DELETE FROM events WHERE source = ? AND file_path = ?',
    );
    const deleteFile = store.database.prepare(
      'DELETE FROM files WHERE source = ? AND file_path = ?',
    );

    for (const file of normalizedFiles) {
      result.deletedEventCount += countMatchingRows(store, 'events', file.source, file.filePath);
      result.deletedFileCount += countMatchingRows(store, 'files', file.source, file.filePath);
      deleteEvents.run(file.source, file.filePath);
      deleteFile.run(file.source, file.filePath);
    }
  });

  return result;
}

export function vacuumEventStore(store: EventStore): void {
  // SQLite requires VACUUM to run outside an explicit transaction.
  store.database.exec('VACUUM');
}

export function replaceFileEvents(store: EventStore, input: ReplaceFileEventsInput): void {
  replaceFilesEvents(store, [input]);
}

/**
 * Replaces the stored events of several files in one transaction. Batching keeps a
 * cold run from paying a WAL commit, and the page rewrites that come with it, per file.
 */
export function replaceFilesEvents(
  store: EventStore,
  inputs: readonly ReplaceFileEventsInput[],
): void {
  if (inputs.length === 0) {
    return;
  }

  const writes = inputs.map((input) => ({
    source: normalizeStoreSource(input.source),
    filePath: normalizeStoreFilePath(input.filePath),
    fingerprint: serializeEventStoreFingerprint(input.fingerprint),
    skippedRows: toNonNegativeInteger(input.skippedRows) ?? 0,
    skippedRowReasons: stringifySkippedRowReasons(input.skippedRowReasons),
    ingestedAt: Math.max(0, Math.trunc(input.now)),
    events: input.events.map((event) => createUsageEvent(event)),
  }));

  const deleteFileEvents = (store.statements.deleteFileEvents ??= store.database.prepare(
    'DELETE FROM events WHERE source = ? AND file_path = ?',
  ));
  const insertEvent = (store.statements.insertEvent ??= store.database.prepare(
    [
      'INSERT INTO events (',
      '  source, file_path, event_index, session_id, timestamp, model, provider, repo_root,',
      '  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,',
      '  cache_write_tokens, cache_write_1h_tokens, total_tokens, content_hash, cost_usd,',
      '  cost_mode',
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ].join('\n'),
  ));
  const upsertFile = (store.statements.upsertFile ??= store.database.prepare(
    [
      'INSERT INTO files (',
      '  source, file_path, fingerprint, skipped_rows, skipped_row_reasons, ingested_at',
      ') VALUES (?, ?, ?, ?, ?, ?)',
      'ON CONFLICT(source, file_path) DO UPDATE SET',
      '  fingerprint = excluded.fingerprint,',
      '  skipped_rows = excluded.skipped_rows,',
      '  skipped_row_reasons = excluded.skipped_row_reasons,',
      '  ingested_at = excluded.ingested_at',
    ].join('\n'),
  ));

  runTransaction(store.database, () => {
    for (const write of writes) {
      const { source, filePath } = write;
      deleteFileEvents.run(source, filePath);

      write.events.forEach((event, eventIndex) => {
        insertEvent.run(
          source,
          filePath,
          eventIndex,
          event.sessionId,
          event.timestamp,
          event.model ?? null,
          event.provider ?? null,
          event.repoRoot ?? null,
          event.inputTokens,
          event.outputTokens,
          event.reasoningTokens,
          event.cacheReadTokens,
          event.cacheWriteTokens,
          event.cacheWrite1hTokens,
          event.totalTokens,
          computeEventContentHash(event),
          event.costUsd ?? null,
          event.costMode,
        );
      });

      upsertFile.run(
        source,
        filePath,
        write.fingerprint,
        write.skippedRows,
        write.skippedRowReasons,
        write.ingestedAt,
      );
    }
  });
}

export function countEvents(store: EventStore): number {
  const row = store.database.prepare('SELECT COUNT(*) AS count FROM events').get();
  return toNonNegativeInteger(row?.count) ?? 0;
}

export function closeEventStore(store: EventStore): void {
  store.database.close();
}
