import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import { normalizeSkippedRowReasons } from '../cli/normalize-skipped-row-reasons.js';
import { createUsageEvent, normalizeSourceId, type UsageEvent } from '../domain/usage-event.js';
import { loadNodeSqliteModule } from '../sources/opencode/node-sqlite-loader.js';
import type { SourceSkippedRowReasonStat } from '../sources/source-adapter.js';
import { getUserCacheRootDir } from '../utils/cache-root-dir.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import {
  computeEventContentHash,
  normalizeStoredEventTuple,
  type StoredEventTuple,
} from './event-store-codec.js';
import {
  type EventStore,
  isEventStoreSqliteModule,
  type LoadEventStoreSqliteModule,
  runTransaction,
  toNonNegativeInteger,
  toNonNegativeNumber,
  toText,
} from './event-store-database.js';
import { assertSupportedSchemaVersion, initializeSchema } from './event-store-schema.js';

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

  return { dependencies };
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
  return path.join(getUserCacheRootDir(), 'llm-usage-metrics', 'events.db');
}

async function prepareEventStoreFile(filePath: string): Promise<void> {
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
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
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
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });

  if (filePath === getDefaultEventStorePath()) {
    await chmod(parentDirectory, 0o700);
  }

  const sqliteModule = await loadSqliteModule();

  if (!isEventStoreSqliteModule(sqliteModule)) {
    throw new Error('Event store requires a sqlite module with a DatabaseSync constructor');
  }

  await prepareEventStoreFile(filePath);

  const database = new sqliteModule.DatabaseSync(filePath, {
    timeout: EVENT_STORE_OPEN_TIMEOUT_MS,
  });

  try {
    assertSupportedSchemaVersion(database);
    database.exec('PRAGMA journal_mode=WAL');
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
        '  cache_write_tokens, total_tokens, cost_usd, cost_mode',
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
  const source = normalizeStoreSource(input.source);
  const filePath = normalizeStoreFilePath(input.filePath);
  const fingerprint = serializeEventStoreFingerprint(input.fingerprint);
  const skippedRows = toNonNegativeInteger(input.skippedRows) ?? 0;
  const skippedRowReasons = stringifySkippedRowReasons(input.skippedRowReasons);
  const ingestedAt = Math.max(0, Math.trunc(input.now));
  const events = input.events.map((event) => createUsageEvent(event));

  runTransaction(store.database, () => {
    store.database
      .prepare('DELETE FROM events WHERE source = ? AND file_path = ?')
      .run(source, filePath);

    const insertEvent = store.database.prepare(
      [
        'INSERT INTO events (',
        '  source, file_path, event_index, session_id, timestamp, model, provider, repo_root,',
        '  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,',
        '  cache_write_tokens, total_tokens, content_hash, cost_usd, cost_mode',
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ].join('\n'),
    );

    events.forEach((event, eventIndex) => {
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
        event.totalTokens,
        computeEventContentHash(event),
        event.costUsd ?? null,
        event.costMode,
      );
    });

    store.database
      .prepare(
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
      )
      .run(source, filePath, fingerprint, skippedRows, skippedRowReasons, ingestedAt);
  });
}

export function countEvents(store: EventStore): number {
  const row = store.database.prepare('SELECT COUNT(*) AS count FROM events').get();
  return toNonNegativeInteger(row?.count) ?? 0;
}

export function closeEventStore(store: EventStore): void {
  store.database.close();
}
