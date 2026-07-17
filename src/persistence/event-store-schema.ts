import { computeEventContentHash, normalizeStoredEvent } from './event-store-codec.js';
import {
  type EventStoreDatabase,
  runTransaction,
  toNonNegativeInteger,
  toText,
} from './event-store-database.js';

export const EVENT_STORE_SCHEMA_VERSION = '3';

// Migration rehash pages through events with keyset pagination so a large
// store never materializes every row in memory at once.
export const MIGRATION_BATCH_SIZE = 5_000;

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

export function migrateSchemaV1ToV2(database: EventStoreDatabase): void {
  runTransaction(database, () => {
    // Re-check under the write lock: another process may have migrated while
    // this one waited on BEGIN IMMEDIATE.
    if (readSchemaVersion(database) !== '1') {
      return;
    }

    database.exec('ALTER TABLE events ADD COLUMN content_hash TEXT');

    const selectBatch = database.prepare(
      [
        'SELECT id, source, session_id, timestamp, model, provider, repo_root,',
        '  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,',
        '  cache_write_tokens, total_tokens, cost_usd, cost_mode',
        'FROM events',
        'WHERE id > ?',
        'ORDER BY id ASC',
        'LIMIT ?',
      ].join('\n'),
    );
    const updateContentHash = database.prepare('UPDATE events SET content_hash = ? WHERE id = ?');

    let lastId = -1;
    for (;;) {
      const rows = selectBatch.all(lastId, MIGRATION_BATCH_SIZE);

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const id = toNonNegativeInteger(row.id);

        if (id === undefined) {
          throw new Error('Cannot migrate event store row without a valid row id');
        }

        lastId = id;

        const event = normalizeStoredEvent(row);

        // An un-normalizable row keeps a NULL hash instead of aborting the
        // migration; the history read path never suppresses NULL-hash files.
        if (!event) {
          continue;
        }

        updateContentHash.run(computeEventContentHash(event), id);
      }
    }

    database.exec('CREATE INDEX IF NOT EXISTS events_content_hash ON events(content_hash)');
    database.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run('2');
  });
}

export function migrateSchemaV2ToV3(database: EventStoreDatabase): void {
  runTransaction(database, () => {
    // Re-check under the write lock: another process may have migrated while
    // this one waited on BEGIN IMMEDIATE.
    if (readSchemaVersion(database) !== '2') {
      return;
    }

    const selectBatch = database.prepare(
      [
        'SELECT id, source, session_id, timestamp, model, provider, repo_root,',
        '  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,',
        '  cache_write_tokens, total_tokens, cost_usd, cost_mode',
        'FROM events',
        'WHERE id > ?',
        'ORDER BY id ASC',
        'LIMIT ?',
      ].join('\n'),
    );
    const updateContentHash = database.prepare('UPDATE events SET content_hash = ? WHERE id = ?');

    let lastId = -1;
    for (;;) {
      const rows = selectBatch.all(lastId, MIGRATION_BATCH_SIZE);

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const id = toNonNegativeInteger(row.id);

        if (id === undefined) {
          throw new Error('Cannot migrate event store row without a valid row id');
        }

        lastId = id;

        const event = normalizeStoredEvent(row);

        // An un-normalizable row gets a NULL hash instead of aborting the
        // migration; the history read path never suppresses NULL-hash files.
        updateContentHash.run(event ? computeEventContentHash(event) : null, id);
      }
    }

    database.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run('3');
  });
}

// Runs before the WAL pragma so an unsupported store is rejected without
// persisting a journal-mode change; initializeSchema re-checks under lock.
export function assertSupportedSchemaVersion(database: EventStoreDatabase): void {
  const schemaVersion = readSchemaVersion(database);

  if (
    schemaVersion !== undefined &&
    schemaVersion !== EVENT_STORE_SCHEMA_VERSION &&
    schemaVersion !== '1' &&
    schemaVersion !== '2'
  ) {
    throw new EventStoreSchemaVersionError(schemaVersion);
  }
}

export function initializeSchema(database: EventStoreDatabase): void {
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
    migrateSchemaV2ToV3(database);
    return;
  }

  if (schemaVersion === '2') {
    migrateSchemaV2ToV3(database);
    return;
  }

  throw new EventStoreSchemaVersionError(schemaVersion);
}
