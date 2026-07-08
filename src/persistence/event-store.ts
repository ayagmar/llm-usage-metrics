import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  createUsageEvent,
  normalizeSourceId,
  type UsageEvent,
  type UsageEventInput,
} from '../domain/usage-event.js';
import { normalizeSkippedRowReasons } from '../cli/normalize-skipped-row-reasons.js';
import { loadNodeSqliteModule } from '../sources/opencode/node-sqlite-loader.js';
import type { SourceSkippedRowReasonStat } from '../sources/source-adapter.js';
import { asRecord } from '../utils/as-record.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getUserCacheRootDir } from '../utils/cache-root-dir.js';

export const EVENT_STORE_SCHEMA_VERSION = '2';

const EVENT_STORE_OPEN_TIMEOUT_MS = 2_000;

type EventStoreStatement = {
  all: (...parameters: unknown[]) => Record<string, unknown>[];
  get: (...parameters: unknown[]) => Record<string, unknown> | undefined;
  run: (...parameters: unknown[]) => unknown;
};

type EventStoreDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => EventStoreStatement;
  close: () => void;
};

type EventStoreSqliteModule = {
  DatabaseSync: new (
    filePath: string,
    options?: {
      readOnly?: boolean;
      timeout?: number;
    },
  ) => EventStoreDatabase;
};

export type LoadEventStoreSqliteModule = () => Promise<unknown>;

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

export type EventStore = {
  database: EventStoreDatabase;
  filePath: string;
  statements: {
    getFileEntry?: EventStoreStatement;
    selectFileEvents?: EventStoreStatement;
  };
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

export class EventStoreSchemaVersionError extends Error {
  readonly schemaVersion: string | undefined;

  constructor(schemaVersion: string | undefined) {
    const versionLabel = schemaVersion ? `v${schemaVersion}` : 'an unknown schema version';
    super(
      `Event store uses ${versionLabel}, which is not supported by this version of llm-usage-metrics (supports v${EVENT_STORE_SCHEMA_VERSION}); leaving store untouched`,
    );
    this.name = 'EventStoreSchemaVersionError';
    this.schemaVersion = schemaVersion;
  }
}

function createSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  skipped_rows INTEGER NOT NULL,
  skipped_row_reasons TEXT,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (source, file_path)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  repo_root TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  content_hash TEXT,
  cost_usd REAL,
  cost_mode TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_file ON events(source, file_path, event_index);
CREATE INDEX IF NOT EXISTS events_content_hash ON events(content_hash);
`;
}

function isEventStoreSqliteModule(value: unknown): value is EventStoreSqliteModule {
  const moduleRecord = asRecord(value);
  return typeof moduleRecord?.DatabaseSync === 'function';
}

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

function toNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.trunc(value);
}

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function toText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
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

function normalizeStoredEvent(row: Record<string, unknown>): UsageEvent | undefined {
  const costMode =
    row.cost_mode === 'explicit' || row.cost_mode === 'estimated' ? row.cost_mode : undefined;

  if (!costMode) {
    return undefined;
  }

  const input: UsageEventInput = {
    source: toText(row.source) ?? '',
    sessionId: toText(row.session_id) ?? '',
    timestamp: toText(row.timestamp) ?? '',
    repoRoot: toText(row.repo_root),
    provider: toText(row.provider),
    model: toText(row.model),
    inputTokens: toNonNegativeInteger(row.input_tokens),
    outputTokens: toNonNegativeInteger(row.output_tokens),
    reasoningTokens: toNonNegativeInteger(row.reasoning_tokens),
    cacheReadTokens: toNonNegativeInteger(row.cache_read_tokens),
    cacheWriteTokens: toNonNegativeInteger(row.cache_write_tokens),
    totalTokens: toNonNegativeInteger(row.total_tokens),
    costUsd: toNonNegativeNumber(row.cost_usd),
    costMode,
  };

  try {
    return createUsageEvent(input);
  } catch {
    return undefined;
  }
}

function listUserTableNames(database: EventStoreDatabase): string[] {
  return database
    .prepare(
      [
        'SELECT name',
        'FROM sqlite_master',
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        'ORDER BY name ASC',
      ].join('\n'),
    )
    .all()
    .map((row) => toText(row.name))
    .filter((name): name is string => Boolean(name));
}

function readSchemaVersion(database: EventStoreDatabase): string | undefined {
  const tableNames = new Set(listUserTableNames(database));

  if (!tableNames.has('meta')) {
    return undefined;
  }

  const schemaVersionRow = database
    .prepare("SELECT value FROM meta WHERE key = 'schemaVersion'")
    .get();
  return toText(schemaVersionRow?.value);
}

function createFreshSchema(database: EventStoreDatabase): void {
  database.exec(createSchemaSql());
  database
    .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schemaVersion', ?)")
    .run(EVENT_STORE_SCHEMA_VERSION);
}

export function computeEventContentHash(event: UsageEvent): string {
  const fields = [
    event.source.toLowerCase(),
    event.timestamp,
    event.model ?? '',
    event.provider ?? '',
    event.repoRoot ?? '',
    event.inputTokens,
    event.outputTokens,
    event.reasoningTokens,
    event.cacheReadTokens,
    event.cacheWriteTokens,
    event.totalTokens,
    event.costMode,
    event.costUsd ?? '',
  ];

  return createHash('sha256').update(fields.map(String).join('\x1f')).digest('hex').slice(0, 16);
}

export function migrateSchemaV1ToV2(database: EventStoreDatabase): void {
  runTransaction(database, () => {
    // Re-check under the write lock: another process may have migrated while
    // this one waited on BEGIN IMMEDIATE.
    if (readSchemaVersion(database) !== '1') {
      return;
    }

    database.exec('ALTER TABLE events ADD COLUMN content_hash TEXT');

    const rows = database
      .prepare(
        [
          'SELECT id, source, session_id, timestamp, model, provider, repo_root,',
          '  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,',
          '  cache_write_tokens, total_tokens, cost_usd, cost_mode',
          'FROM events',
          'ORDER BY id ASC',
        ].join('\n'),
      )
      .all();
    const updateContentHash = database.prepare('UPDATE events SET content_hash = ? WHERE id = ?');

    for (const row of rows) {
      const id = toNonNegativeInteger(row.id);

      if (id === undefined) {
        throw new Error('Cannot migrate event store row without a valid row id');
      }

      const event = normalizeStoredEvent(row);

      // An un-normalizable row keeps a NULL hash instead of aborting the
      // migration; the history read path never suppresses NULL-hash files.
      if (!event) {
        continue;
      }

      updateContentHash.run(computeEventContentHash(event), id);
    }

    database.exec('CREATE INDEX IF NOT EXISTS events_content_hash ON events(content_hash)');
    database
      .prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'")
      .run(EVENT_STORE_SCHEMA_VERSION);
  });
}

function initializeSchema(database: EventStoreDatabase): void {
  const tableNames = listUserTableNames(database);

  if (tableNames.length === 0) {
    createFreshSchema(database);
    return;
  }

  const schemaVersion = readSchemaVersion(database);

  if (schemaVersion === EVENT_STORE_SCHEMA_VERSION) {
    return;
  }

  if (schemaVersion === '1') {
    migrateSchemaV1ToV2(database);
    return;
  }

  throw new EventStoreSchemaVersionError(schemaVersion);
}

function runTransaction(database: EventStoreDatabase, task: () => void): void {
  database.exec('BEGIN IMMEDIATE');

  try {
    task();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function deleteFileEntry(store: EventStore, source: string, filePath: string): void {
  deleteStoredFiles(store, [{ source, filePath }]);
}

export function getDefaultEventStorePath(): string {
  return path.join(getUserCacheRootDir(), 'llm-usage-metrics', 'events.db');
}

export async function openEventStore(
  filePath: string = getDefaultEventStorePath(),
  loadSqliteModule: LoadEventStoreSqliteModule = loadEventStoreSqliteModule,
): Promise<EventStore> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const sqliteModule = await loadSqliteModule();

  if (!isEventStoreSqliteModule(sqliteModule)) {
    throw new Error('Event store requires a sqlite module with a DatabaseSync constructor');
  }

  const database = new sqliteModule.DatabaseSync(filePath, {
    timeout: EVENT_STORE_OPEN_TIMEOUT_MS,
  });
  database.exec('PRAGMA journal_mode=WAL');
  initializeSchema(database);

  return {
    database,
    filePath,
    statements: {},
  };
}

export type EventStoreSummary = {
  eventCount: number;
  schemaVersion?: string;
};

export type EventStoreStoredFile = {
  source: string;
  filePath: string;
};

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
): Record<string, unknown>[] {
  const statement = (store.statements.selectFileEvents ??= store.database.prepare(
    [
      'SELECT source, session_id, timestamp, model, provider, repo_root,',
      '  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,',
      '  cache_write_tokens, total_tokens, cost_usd, cost_mode',
      'FROM events',
      'WHERE source = ? AND file_path = ?',
      'ORDER BY event_index ASC',
    ].join('\n'),
  ));
  return statement.all(source, filePath);
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
    const event = normalizeStoredEvent(row);

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
    const event = normalizeStoredEvent(row);

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
