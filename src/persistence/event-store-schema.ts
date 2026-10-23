import { computeEventContentHash } from '@ayagmar/agent-sessions';

import { createReadCursorsSql } from './event-store-append.js';
import { normalizeStoredEvent, selectSingleRequestBeforeFlagSql } from './event-store-codec.js';
import { createGitRootsSql } from './event-store-git-roots.js';
import {
  type EventStoreDatabase,
  runTransaction,
  toNonNegativeInteger,
  toText,
} from './event-store-database.js';

export const EVENT_STORE_SCHEMA_VERSION = '5';

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
${createFileTablesSql()}
${createOverrideOnlyFilesSql()}
${createReadCursorsSql()}
${createGitRootsSql()}
`;
}

// A stored file and its rows. Usage events, tool calls and messages key the file by its
// integer id, so a row does not repeat the file's source and path, and a file's rows sit
// together in event_index order. Tool calls and messages hold timestamps as epoch
// milliseconds, which read back as the ISO strings the events carry; their event_index is
// the event's position in the file's tool calls and messages together, so the two tables
// read back in the order the adapter yielded them. Message text is never stored.
function createFileTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  skipped_rows INTEGER NOT NULL,
  skipped_row_reasons TEXT,
  ingested_at INTEGER NOT NULL,
  UNIQUE (source, file_path)
);
CREATE TABLE IF NOT EXISTS events (
  file_id INTEGER NOT NULL,
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
  cache_write_1h_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  content_hash TEXT,
  cost_usd REAL,
  cost_mode TEXT NOT NULL,
  single_request INTEGER NOT NULL,
  message_id TEXT,
  request_id TEXT,
  PRIMARY KEY (file_id, event_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS events_content_hash ON events(content_hash);
CREATE TABLE IF NOT EXISTS tool_calls (
  file_id INTEGER NOT NULL,
  event_index INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  tool_call_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  message_id TEXT,
  PRIMARY KEY (file_id, event_index)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS messages (
  file_id INTEGER NOT NULL,
  event_index INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  role TEXT NOT NULL,
  message_id TEXT,
  model TEXT,
  text_length INTEGER NOT NULL,
  PRIMARY KEY (file_id, event_index)
) WITHOUT ROWID;`;
}

// Stored files that only a run with a custom directory (--claude-dir, --source-dir...)
// has discovered. A default run never serves them as history: they were never in the
// source's usual location. Added without a schema version bump, since older builds that
// ignore the table still read and write the store correctly.
function createOverrideOnlyFilesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS override_only_files (
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  PRIMARY KEY (source, file_path)
);`;
}

// The tables added to the v5 layout without a version bump, created in a store that
// lacks them.
function ensureAddedTables(database: EventStoreDatabase): void {
  const tableNames = listUserTableNames(database);

  if (!tableNames.includes('override_only_files')) {
    database.exec(createOverrideOnlyFilesSql());
  }

  if (!tableNames.includes('file_read_cursors')) {
    database.exec(createReadCursorsSql());
  }

  if (!tableNames.includes('git_roots')) {
    database.exec(createGitRootsSql());
  }

  ensureEventIdColumns(database);
}

/**
 * Whether the events table has the message and request id columns, added to the v5 layout
 * without a version bump: older builds name the columns they write, so their rows hold
 * NULL ids. A read-only open of a store that predates the columns reads NULL ids.
 */
export function hasEventIdColumns(database: EventStoreDatabase): boolean {
  return database
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('events')
    .some((row) => row.name === 'message_id');
}

function ensureEventIdColumns(database: EventStoreDatabase): void {
  if (hasEventIdColumns(database)) {
    return;
  }

  runTransaction(database, () => {
    // Re-check under the write lock: another process may have added them meanwhile.
    if (hasEventIdColumns(database)) {
      return;
    }

    database.exec('ALTER TABLE events ADD COLUMN message_id TEXT');
    database.exec('ALTER TABLE events ADD COLUMN request_id TEXT');
  });
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

/**
 * The store's schema version. A pre-release build stamped v5 before v5 keyed events by
 * file id, so a v5 store whose events lack `file_id` still has the v4 layout: it reads as
 * v4, and opening it for writes migrates it.
 */
export function readSchemaVersion(database: EventStoreDatabase): string | undefined {
  const tableNames = new Set(listUserTableNames(database));

  if (!tableNames.has('meta')) {
    return undefined;
  }

  const schemaVersionRow = database
    .prepare("SELECT value FROM meta WHERE key = 'schemaVersion'")
    .get();
  const schemaVersion = toText(schemaVersionRow?.value);

  return schemaVersion === '5' && tableNames.has('events') && !hasEventsFileIdColumn(database)
    ? '4'
    : schemaVersion;
}

function hasEventsFileIdColumn(database: EventStoreDatabase): boolean {
  return database
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('events')
    .some((row) => row.name === 'file_id');
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
        '  cache_write_tokens, 0 AS cache_write_1h_tokens, total_tokens, cost_usd, cost_mode',
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
        '  cache_write_tokens, 0 AS cache_write_1h_tokens, total_tokens, cost_usd, cost_mode',
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

// Events stored before v4 read as having no one-hour cache writes; reparsing a file that
// is still on disk fills them in.
function migrateSchemaV3ToV4(database: EventStoreDatabase): void {
  runTransaction(database, () => {
    // Re-check under the write lock: another process may have migrated while
    // this one waited on BEGIN IMMEDIATE.
    if (readSchemaVersion(database) !== '3') {
      return;
    }

    database.exec('ALTER TABLE events ADD COLUMN cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0');
    database.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run('4');
  });
}

// v5 keys every file's rows by an integer file id: the v4 tables are copied into the v5
// layout. An event row without a files row was never read by a report's file lookups; it
// is left behind. Files stored before v5 have no tool call or message rows. The stored
// fingerprint of a source that keeps them changed with v5, so its files on disk re-ingest
// on the next run.
// A pre-release build that stamped v5 over the v4 tables may have left tool call and message
// tables in an older layout: they are dropped, and their files re-ingest with the rest. v4 rows have no single-request flag; it is set for the sources whose
// every event was one request then.
/** Whether this call copied the tables; false when the store was not at v4. */
export function migrateSchemaV4ToV5(database: EventStoreDatabase): boolean {
  return runTransaction(database, () => {
    // Re-check under the write lock: another process may have migrated while
    // this one waited on BEGIN IMMEDIATE.
    if (readSchemaVersion(database) !== '4') {
      return false;
    }

    database.exec(`
ALTER TABLE files RENAME TO v4_files;
ALTER TABLE events RENAME TO v4_events;
DROP INDEX IF EXISTS events_content_hash;
DROP TABLE IF EXISTS tool_calls;
DROP TABLE IF EXISTS messages;
${createFileTablesSql()}
INSERT INTO files (source, file_path, fingerprint, skipped_rows, skipped_row_reasons, ingested_at)
SELECT source, file_path, fingerprint, skipped_rows, skipped_row_reasons, ingested_at
FROM v4_files
ORDER BY source, file_path;
INSERT OR IGNORE INTO events (
  file_id, event_index, session_id, timestamp, model, provider, repo_root,
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
  cache_write_tokens, cache_write_1h_tokens, total_tokens, content_hash, cost_usd, cost_mode,
  single_request
)
SELECT files.id, v4_events.event_index, v4_events.session_id, v4_events.timestamp,
  v4_events.model, v4_events.provider, v4_events.repo_root, v4_events.input_tokens,
  v4_events.output_tokens, v4_events.reasoning_tokens, v4_events.cache_read_tokens,
  v4_events.cache_write_tokens, v4_events.cache_write_1h_tokens, v4_events.total_tokens,
  v4_events.content_hash, v4_events.cost_usd, v4_events.cost_mode,
  ${selectSingleRequestBeforeFlagSql('files.source')}
FROM files
CROSS JOIN v4_events
WHERE v4_events.source = files.source AND v4_events.file_path = files.file_path
ORDER BY files.id, v4_events.event_index;
DROP TABLE v4_events;
DROP TABLE v4_files;
`);
    database.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run('5');
    return true;
  });
}

const OLDER_SCHEMA_VERSIONS: readonly string[] = ['1', '2', '3', '4'];

/** Versions this build reads directly or migrates on open. */
export function isSupportedSchemaVersion(schemaVersion: string): boolean {
  return (
    schemaVersion === EVENT_STORE_SCHEMA_VERSION || OLDER_SCHEMA_VERSIONS.includes(schemaVersion)
  );
}

/**
 * Whether a supported store of this version has what `version` added: the one-hour cache
 * write column (4), the tool_calls and messages tables and rows keyed by file id (5). A
 * read-only open cannot migrate.
 */
export function hasSchemaVersion(schemaVersion: string | undefined, version: number): boolean {
  return schemaVersion !== undefined && isSupportedSchemaVersion(schemaVersion)
    ? Number(schemaVersion) >= version
    : false;
}

// Runs before the WAL pragma so an unsupported store is rejected without
// persisting a journal-mode change; initializeSchema re-checks under lock.
export function assertSupportedSchemaVersion(database: EventStoreDatabase): void {
  const schemaVersion = readSchemaVersion(database);

  if (schemaVersion !== undefined && !isSupportedSchemaVersion(schemaVersion)) {
    throw new EventStoreSchemaVersionError(schemaVersion);
  }
}

export function initializeSchema(database: EventStoreDatabase): void {
  const copiedTables = createOrMigrateSchema(database);
  ensureAddedTables(database);

  // The dropped v4 tables leave their pages free, and the file would keep its v4 size
  // plus the copy. SQLite requires VACUUM to run outside an explicit transaction.
  // The migration has committed: a vacuum that fails, because another run holds the write
  // lock or the disk lacks room for the copy, leaves the space to `prune --apply`.
  if (copiedTables) {
    try {
      database.exec('VACUUM');
    } catch {
      // The store is usable at its current size.
    }
  }
}

/** Whether a migration copied the tables into a new layout. */
function createOrMigrateSchema(database: EventStoreDatabase): boolean {
  if (listUserTableNames(database).length === 0) {
    const createdSchema = runTransaction(database, () => {
      // Re-check under the write lock: a concurrent first run may have created the
      // schema while this one waited, and must never see it half-created.
      if (listUserTableNames(database).length > 0) {
        return false;
      }

      createFreshSchema(database);
      return true;
    });

    if (createdSchema) {
      return false;
    }
  }

  const schemaVersion = readSchemaVersion(database);

  if (schemaVersion === EVENT_STORE_SCHEMA_VERSION) {
    return false;
  }

  if (schemaVersion === undefined || !OLDER_SCHEMA_VERSIONS.includes(schemaVersion)) {
    throw new EventStoreSchemaVersionError(schemaVersion);
  }

  // Each step re-checks the version under its own lock, so the chain starts where the
  // store is and skips what a concurrent run already migrated.
  migrateSchemaV1ToV2(database);
  migrateSchemaV2ToV3(database);
  migrateSchemaV3ToV4(database);
  return migrateSchemaV4ToV5(database);
}
