import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  computeEventContentHash,
  closeEventStore,
  countEvents,
  deleteStoredFiles,
  EVENT_STORE_SCHEMA_VERSION,
  EventStoreSchemaVersionError,
  getDefaultEventStorePath,
  getFileEntry,
  migrateSchemaV1ToV2,
  openEventStore,
  readEventStoreSummary,
  readFileEvents,
  replaceFileEvents,
  serializeEventStoreFingerprint,
  type EventStore,
  type EventStoreFileFingerprint,
  vacuumEventStore,
} from '../../src/persistence/event-store.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { loadNodeSqliteModule } from '../../src/sources/opencode/node-sqlite-loader.js';

const tempDirs: string[] = [];

const V1_SCHEMA_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE files (
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  skipped_rows INTEGER NOT NULL,
  skipped_row_reasons TEXT,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (source, file_path)
);
CREATE TABLE events (
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
  cost_usd REAL,
  cost_mode TEXT NOT NULL
);
CREATE INDEX events_file ON events(source, file_path, event_index);
`;

type TestSqliteModule = {
  DatabaseSync: new (
    filePath: string,
    options?: { readOnly?: boolean; timeout?: number },
  ) => EventStore['database'];
};

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function createFingerprint(
  dependencies: EventStoreFileFingerprint['dependencies'] = [
    { path: '/tmp/session.jsonl', exists: true, size: 10, mtimeMs: 20 },
  ],
): EventStoreFileFingerprint {
  return { dependencies };
}

function createEvent(overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {}) {
  return createUsageEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp: '2026-02-01T00:00:00.000Z',
    inputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 3,
    costMode: 'estimated',
    ...overrides,
  });
}

async function loadTestSqliteModule(): Promise<TestSqliteModule> {
  const sqliteModule = await loadNodeSqliteModule('Event store test');
  const testSqliteModule = sqliteModule as unknown as Partial<TestSqliteModule>;

  if (typeof testSqliteModule.DatabaseSync !== 'function') {
    throw new Error('Event store tests require node:sqlite DatabaseSync support.');
  }

  return testSqliteModule as TestSqliteModule;
}

async function openTestDatabase(filePath: string): Promise<EventStore['database']> {
  const sqliteModule = await loadTestSqliteModule();
  return new sqliteModule.DatabaseSync(filePath, { timeout: 2_000 });
}

async function writeV1Database(
  filePath: string,
  options: {
    schemaVersion?: string;
    filePath?: string;
    events?: ReturnType<typeof createEvent>[];
    createIndexNameConflict?: boolean;
  } = {},
): Promise<void> {
  const database = await openTestDatabase(filePath);

  try {
    database.exec(V1_SCHEMA_SQL);
    database
      .prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?)")
      .run(options.schemaVersion ?? '1');
    database
      .prepare(
        [
          'INSERT INTO files (',
          '  source, file_path, fingerprint, skipped_rows, skipped_row_reasons, ingested_at',
          ') VALUES (?, ?, ?, ?, ?, ?)',
        ].join('\n'),
      )
      .run(
        'codex',
        options.filePath ?? '/tmp/session.jsonl',
        serializeEventStoreFingerprint(createFingerprint()),
        0,
        null,
        1_000,
      );

    const insertEvent = database.prepare(
      [
        'INSERT INTO events (',
        '  source, file_path, event_index, session_id, timestamp, model, provider, repo_root,',
        '  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,',
        '  cache_write_tokens, total_tokens, cost_usd, cost_mode',
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ].join('\n'),
    );

    (options.events ?? [createEvent()]).forEach((event, index) => {
      insertEvent.run(
        event.source,
        options.filePath ?? '/tmp/session.jsonl',
        index,
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
        event.costUsd ?? null,
        event.costMode,
      );
    });

    if (options.createIndexNameConflict) {
      database.exec('CREATE TABLE events_content_hash (id INTEGER PRIMARY KEY)');
    }
  } finally {
    database.close();
  }
}

type FakeSqliteModule = {
  DatabaseSync: new (
    filePath: string,
    options?: { readOnly?: boolean; timeout?: number },
  ) => unknown;
  constructorCalls: Array<{
    filePath: string;
    options?: { readOnly?: boolean; timeout?: number };
  }>;
  execCalls: string[];
  prepareCalls: string[];
  closeCalls: number;
};

function createFakeSqliteModule(
  rowsBySql: Record<string, Record<string, unknown> | undefined> = {},
): FakeSqliteModule {
  const fakeSqlite: FakeSqliteModule = {
    DatabaseSync: class {
      constructor(filePath: string, options?: { readOnly?: boolean; timeout?: number }) {
        fakeSqlite.constructorCalls.push({ filePath, options });
      }

      exec(sql: string): void {
        fakeSqlite.execCalls.push(sql);
      }

      prepare(sql: string) {
        fakeSqlite.prepareCalls.push(sql);
        return {
          all: () => [],
          get: () => rowsBySql[sql],
          run: () => undefined,
        };
      }

      close(): void {
        fakeSqlite.closeCalls += 1;
      }
    },
    constructorCalls: [],
    execCalls: [],
    prepareCalls: [],
    closeCalls: 0,
  };

  return fakeSqlite;
}

async function createTempStore(name: string): Promise<EventStore> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), name));
  tempDirs.push(tempDir);

  return openEventStore(path.join(tempDir, 'nested', 'events.db'));
}

function replaceCodexFile(
  store: EventStore,
  options: {
    filePath?: string;
    fingerprint?: EventStoreFileFingerprint;
    events?: ReturnType<typeof createEvent>[];
    skippedRows?: number;
    skippedRowReasons?: Array<{ reason: string; count: number }>;
    now?: number;
  } = {},
): void {
  replaceFileEvents(store, {
    source: 'codex',
    filePath: options.filePath ?? '/tmp/session.jsonl',
    fingerprint: options.fingerprint ?? createFingerprint(),
    events: options.events ?? [createEvent()],
    skippedRows: options.skippedRows ?? 0,
    skippedRowReasons: options.skippedRowReasons,
    now: options.now ?? 1_000,
  });
}

describe('event-store', () => {
  it('resolves the default path under the user cache root', () => {
    expect(getDefaultEventStorePath()).toContain(path.join('llm-usage-metrics', 'events.db'));
  });

  it('bootstraps the schema and creates parent directories', async () => {
    const store = await createTempStore('event-store-bootstrap-');

    try {
      expect(countEvents(store)).toBe(0);
      expect(
        store.database.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get(),
      ).toEqual({ value: EVENT_STORE_SCHEMA_VERSION });
    } finally {
      closeEventStore(store);
    }
  });

  it('migrates a real v1 database to v2 without losing rows', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-v1-migrate-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'events.db');
    const migratedEvent = createEvent({
      sessionId: 'path-derived-session',
      provider: 'OpenAI-Codex',
      model: ' GPT-4.1 ',
      repoRoot: '/workspace/repo',
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
      totalTokens: 42,
      costUsd: 0.123,
      costMode: 'explicit',
    });
    await writeV1Database(dbPath, { events: [migratedEvent] });

    const store = await openEventStore(dbPath);

    try {
      expect(countEvents(store)).toBe(1);
      expect(
        store.database.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get(),
      ).toEqual({ value: EVENT_STORE_SCHEMA_VERSION });
      expect(
        store.database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get('events_content_hash'),
      ).toEqual({ name: 'events_content_hash' });
      expect(store.database.prepare('SELECT content_hash FROM events').get()).toEqual({
        content_hash: computeEventContentHash(migratedEvent),
      });
      expect(readFileEvents(store, 'codex', '/tmp/session.jsonl')).toEqual([migratedEvent]);
    } finally {
      closeEventStore(store);
    }
  });

  it('migrates a multi-row v1 database with distinct content hashes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-v1-multi-row-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'events.db');
    const firstEvent = createEvent({ sessionId: 'first' });
    const secondEvent = createEvent({ sessionId: 'second', inputTokens: 20, totalTokens: 22 });
    const thirdEvent = createEvent({ sessionId: 'third', inputTokens: 30, totalTokens: 32 });
    await writeV1Database(dbPath, { events: [firstEvent, secondEvent, thirdEvent] });

    const store = await openEventStore(dbPath);

    try {
      expect(
        store.database.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get(),
      ).toEqual({ value: EVENT_STORE_SCHEMA_VERSION });
      expect(readFileEvents(store, 'codex', '/tmp/session.jsonl')).toEqual([
        firstEvent,
        secondEvent,
        thirdEvent,
      ]);

      const contentHashes = store.database
        .prepare('SELECT content_hash FROM events ORDER BY id ASC')
        .all()
        .map((row) => row.content_hash);

      expect(contentHashes).toEqual([
        computeEventContentHash(firstEvent),
        computeEventContentHash(secondEvent),
        computeEventContentHash(thirdEvent),
      ]);
      expect(new Set(contentHashes).size).toBe(3);
    } finally {
      closeEventStore(store);
    }
  });

  it('migrates a zero-row v1 database cleanly', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-v1-zero-row-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'events.db');
    await writeV1Database(dbPath, { events: [] });

    const store = await openEventStore(dbPath);

    try {
      expect(countEvents(store)).toBe(0);
      expect(
        store.database.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get(),
      ).toEqual({ value: EVENT_STORE_SCHEMA_VERSION });
      expect(
        store.database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get('events_content_hash'),
      ).toEqual({ name: 'events_content_hash' });
    } finally {
      closeEventStore(store);
    }
  });

  it('completes a v1 migration despite a poisoned row, leaving its hash null', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-v1-poisoned-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'events.db');
    const firstGoodEvent = createEvent({ sessionId: 'good-first' });
    const poisonedEvent = createEvent({ sessionId: 'poisoned', inputTokens: 7, totalTokens: 9 });
    const lastGoodEvent = createEvent({
      sessionId: 'good-last',
      inputTokens: 20,
      totalTokens: 22,
    });
    await writeV1Database(dbPath, { events: [firstGoodEvent, poisonedEvent, lastGoodEvent] });

    const rawDatabase = await openTestDatabase(dbPath);

    try {
      rawDatabase
        .prepare("UPDATE events SET cost_mode = 'bogus' WHERE session_id = ?")
        .run('poisoned');
    } finally {
      rawDatabase.close();
    }

    const store = await openEventStore(dbPath);

    try {
      expect(countEvents(store)).toBe(3);
      expect(
        store.database.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get(),
      ).toEqual({ value: EVENT_STORE_SCHEMA_VERSION });
      expect(
        store.database.prepare('SELECT session_id, content_hash FROM events ORDER BY id ASC').all(),
      ).toEqual([
        { session_id: 'good-first', content_hash: computeEventContentHash(firstGoodEvent) },
        { session_id: 'poisoned', content_hash: null },
        { session_id: 'good-last', content_hash: computeEventContentHash(lastGoodEvent) },
      ]);
    } finally {
      closeEventStore(store);
    }
  });

  it('no-ops when the v1 migration runs against an already migrated database', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-v1-already-migrated-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'events.db');
    const event = createEvent();
    await writeV1Database(dbPath, { events: [event] });

    const store = await openEventStore(dbPath);

    try {
      migrateSchemaV1ToV2(store.database);

      expect(
        store.database.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get(),
      ).toEqual({ value: EVENT_STORE_SCHEMA_VERSION });
      expect(store.database.prepare('SELECT content_hash FROM events').get()).toEqual({
        content_hash: computeEventContentHash(event),
      });
      expect(readFileEvents(store, 'codex', '/tmp/session.jsonl')).toEqual([event]);
    } finally {
      closeEventStore(store);
    }
  });

  it('stores a content hash for freshly ingested events', async () => {
    const store = await createTempStore('event-store-ingest-hash-');

    try {
      replaceCodexFile(store);

      expect(store.database.prepare('SELECT content_hash FROM events').get()).toEqual({
        content_hash: computeEventContentHash(createEvent()),
      });
    } finally {
      closeEventStore(store);
    }
  });

  it('rolls back a failed v1 migration and leaves the v1 database valid', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-v1-rollback-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'events.db');
    await writeV1Database(dbPath, { createIndexNameConflict: true });

    await expect(openEventStore(dbPath)).rejects.toThrow('events_content_hash');

    const database = await openTestDatabase(dbPath);

    try {
      expect(database.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({
        value: '1',
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({
        count: 1,
      });
      expect(
        database
          .prepare("PRAGMA table_info('events')")
          .all()
          .map((row) => row.name),
      ).not.toContain('content_hash');
    } finally {
      database.close();
    }
  });

  it('computes deterministic content hashes while excluding session identity', () => {
    const baseline = createEvent({
      sessionId: 'derived-from-old-path',
      inputTokens: 10,
      totalTokens: 12,
    });
    const movedPathEvent = createEvent({
      sessionId: 'derived-from-new-path',
      inputTokens: 10,
      totalTokens: 12,
    });
    const changedUsage = createEvent({
      sessionId: 'derived-from-old-path',
      inputTokens: 11,
      totalTokens: 13,
    });

    expect(computeEventContentHash(baseline)).toBe(computeEventContentHash(baseline));
    expect(computeEventContentHash(movedPathEvent)).toBe(computeEventContentHash(baseline));
    expect(computeEventContentHash(changedUsage)).not.toBe(computeEventContentHash(baseline));
  });

  it('rejects invalid sqlite loaders and store keys', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-invalid-loader-'));
    tempDirs.push(tempDir);

    await expect(openEventStore(path.join(tempDir, 'events.db'), async () => ({}))).rejects.toThrow(
      'Event store requires a sqlite module',
    );

    const store = await createTempStore('event-store-invalid-keys-');

    try {
      expect(() => {
        replaceFileEvents(store, {
          source: '   ',
          filePath: '/tmp/session.jsonl',
          fingerprint: createFingerprint(),
          events: [createEvent()],
          skippedRows: 0,
          now: 1_000,
        });
      }).toThrow('source');
      expect(() => getFileEntry(store, 'codex', '   ')).toThrow('file path');
      expect(() => serializeEventStoreFingerprint({ dependencies: [] })).toThrow('fingerprint');
    } finally {
      closeEventStore(store);
    }
  });

  it('replaces a file idempotently', async () => {
    const store = await createTempStore('event-store-idempotent-');

    try {
      replaceCodexFile(store);
      replaceCodexFile(store);

      expect(countEvents(store)).toBe(1);
      expect(readFileEvents(store, 'codex', '/tmp/session.jsonl')).toEqual([createEvent()]);
    } finally {
      closeEventStore(store);
    }
  });

  it('swaps rows for a changed file atomically', async () => {
    const store = await createTempStore('event-store-replace-');

    try {
      replaceCodexFile(store, {
        events: [createEvent({ sessionId: 'old-a' }), createEvent({ sessionId: 'old-b' })],
      });
      replaceCodexFile(store, {
        events: [createEvent({ sessionId: 'new-only', inputTokens: 5, totalTokens: 7 })],
      });

      expect(countEvents(store)).toBe(1);
      expect(readFileEvents(store, 'codex', '/tmp/session.jsonl')).toEqual([
        createEvent({ sessionId: 'new-only', inputTokens: 5, totalTokens: 7 }),
      ]);
    } finally {
      closeEventStore(store);
    }
  });

  it('deletes exactly the named stored files and their events', async () => {
    const store = await createTempStore('event-store-delete-files-');
    const firstDeletedEvent = createEvent({ sessionId: 'delete-1' });
    const secondDeletedEvent = createEvent({
      sessionId: 'delete-2',
      timestamp: '2026-02-01T00:00:01.000Z',
    });
    const keptEvent = createEvent({ sessionId: 'keep' });

    try {
      replaceCodexFile(store, {
        filePath: '/tmp/delete.jsonl',
        events: [firstDeletedEvent, secondDeletedEvent],
      });
      replaceCodexFile(store, { filePath: '/tmp/keep.jsonl', events: [keptEvent] });

      const result = deleteStoredFiles(store, [{ source: 'codex', filePath: '/tmp/delete.jsonl' }]);

      expect(result).toEqual({ deletedFileCount: 1, deletedEventCount: 2 });
      expect(countEvents(store)).toBe(1);
      expect(readFileEvents(store, 'codex', '/tmp/delete.jsonl')).toEqual([]);
      expect(readFileEvents(store, 'codex', '/tmp/keep.jsonl')).toEqual([keptEvent]);
      expect(
        store.database.prepare('SELECT source, file_path FROM files ORDER BY file_path').all(),
      ).toEqual([{ source: 'codex', file_path: '/tmp/keep.jsonl' }]);
    } finally {
      closeEventStore(store);
    }
  });

  it('vacuums a temp database after bulk deletes', async () => {
    const store = await createTempStore('event-store-vacuum-');

    try {
      const filesToDelete: Array<{ source: string; filePath: string }> = [];

      for (let index = 0; index < 180; index += 1) {
        const filePath = `/tmp/bulk-${index}.jsonl`;
        filesToDelete.push({ source: 'codex', filePath });
        replaceCodexFile(store, {
          filePath,
          events: [
            createEvent({
              sessionId: `session-${index}`,
              repoRoot: `/workspace/${'nested/'.repeat(80)}${index}`,
            }),
          ],
        });
      }

      store.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const sizeBeforeDelete = (await stat(store.filePath)).size;
      deleteStoredFiles(store, filesToDelete);
      store.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const sizeBeforeVacuum = (await stat(store.filePath)).size;

      vacuumEventStore(store);
      store.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');

      expect(sizeBeforeVacuum).toBeGreaterThanOrEqual(sizeBeforeDelete);
      expect((await stat(store.filePath)).size).toBeLessThan(sizeBeforeVacuum);
    } finally {
      closeEventStore(store);
    }
  });

  it('preserves event order within a file', async () => {
    const store = await createTempStore('event-store-order-');

    try {
      replaceCodexFile(store, {
        events: [
          createEvent({ sessionId: 'second', timestamp: '2026-02-01T00:00:02.000Z' }),
          createEvent({ sessionId: 'first', timestamp: '2026-02-01T00:00:01.000Z' }),
        ],
      });

      expect(
        readFileEvents(store, 'codex', '/tmp/session.jsonl')?.map((event) => event.sessionId),
      ).toEqual(['second', 'first']);
    } finally {
      closeEventStore(store);
    }
  });

  it('round-trips file diagnostics and canonical fingerprint JSON', async () => {
    const store = await createTempStore('event-store-diagnostics-');
    const fingerprint = createFingerprint([
      { path: '/tmp/z-sidecar.json', exists: false },
      { path: '/tmp/session.jsonl', exists: true, size: 10.9, mtimeMs: 20.25 },
    ]);

    try {
      replaceCodexFile(store, {
        fingerprint,
        skippedRows: 3,
        skippedRowReasons: [
          { reason: 'malformed json', count: 2 },
          { reason: 'zero', count: 0 },
        ],
      });

      expect(getFileEntry(store, 'CODEX', '/tmp/session.jsonl')).toEqual({
        fingerprint: serializeEventStoreFingerprint(fingerprint),
        skippedRows: 3,
        skippedRowReasons: [{ reason: 'malformed json', count: 2 }],
      });
    } finally {
      closeEventStore(store);
    }
  });

  it('invalidates only the file with a malformed stored event row', async () => {
    const store = await createTempStore('event-store-malformed-row-');

    try {
      replaceCodexFile(store, {
        filePath: '/tmp/bad.jsonl',
        events: [createEvent({ sessionId: 'bad' })],
      });
      replaceCodexFile(store, {
        filePath: '/tmp/good.jsonl',
        events: [createEvent({ sessionId: 'good' })],
      });
      store.database
        .prepare("UPDATE events SET cost_mode = 'broken' WHERE file_path = ?")
        .run('/tmp/bad.jsonl');

      expect(readFileEvents(store, 'codex', '/tmp/bad.jsonl')).toBeUndefined();
      expect(getFileEntry(store, 'codex', '/tmp/bad.jsonl')).toBeUndefined();
      expect(readFileEvents(store, 'codex', '/tmp/good.jsonl')).toEqual([
        createEvent({ sessionId: 'good' }),
      ]);
      expect(countEvents(store)).toBe(1);
    } finally {
      closeEventStore(store);
    }
  });

  it('invalidates malformed file metadata rows', async () => {
    const store = await createTempStore('event-store-malformed-file-metadata-');

    try {
      replaceCodexFile(store);
      store.database
        .prepare("UPDATE files SET fingerprint = '' WHERE file_path = ?")
        .run('/tmp/session.jsonl');

      expect(getFileEntry(store, 'codex', '/tmp/session.jsonl')).toBeUndefined();
      expect(countEvents(store)).toBe(0);
    } finally {
      closeEventStore(store);
    }
  });

  it('rejects unsupported schema versions without mutating stored rows', async () => {
    const store = await createTempStore('event-store-version-');
    const dbPath = store.filePath;

    try {
      replaceCodexFile(store);
      store.database.prepare("UPDATE meta SET value = '999' WHERE key = 'schemaVersion'").run();
    } finally {
      closeEventStore(store);
    }

    await expect(openEventStore(dbPath)).rejects.toBeInstanceOf(EventStoreSchemaVersionError);
    await expect(readEventStoreSummary(dbPath)).resolves.toEqual({
      eventCount: 1,
      schemaVersion: '999',
    });
  });

  it('opens writable stores with a busy timeout and WAL journal mode', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-open-options-'));
    tempDirs.push(tempDir);

    const fakeSqlite = createFakeSqliteModule();
    const store = await openEventStore(path.join(tempDir, 'events.db'), async () => fakeSqlite);

    expect(fakeSqlite.constructorCalls).toEqual([
      {
        filePath: path.join(tempDir, 'events.db'),
        options: { timeout: 2_000 },
      },
    ]);
    expect(fakeSqlite.execCalls).toContain('PRAGMA journal_mode=WAL');
    closeEventStore(store);
  });

  it('prepares hot read statements once per store connection', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-hot-statements-'));
    tempDirs.push(tempDir);

    const fakeSqlite = createFakeSqliteModule();
    const store = await openEventStore(path.join(tempDir, 'events.db'), async () => fakeSqlite);

    const getFileEntrySql = [
      'SELECT fingerprint, skipped_rows, skipped_row_reasons',
      'FROM files',
      'WHERE source = ? AND file_path = ?',
    ].join('\n');
    const selectFileEventsSql = [
      'SELECT source, session_id, timestamp, model, provider, repo_root,',
      '  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,',
      '  cache_write_tokens, total_tokens, cost_usd, cost_mode',
      'FROM events',
      'WHERE source = ? AND file_path = ?',
      'ORDER BY event_index ASC',
    ].join('\n');

    getFileEntry(store, 'codex', '/tmp/session.jsonl');
    getFileEntry(store, 'codex', '/tmp/session.jsonl');
    readFileEvents(store, 'codex', '/tmp/session.jsonl');
    readFileEvents(store, 'codex', '/tmp/session.jsonl');

    expect(fakeSqlite.prepareCalls.filter((sql) => sql === getFileEntrySql)).toHaveLength(1);
    expect(fakeSqlite.prepareCalls.filter((sql) => sql === selectFileEventsSql)).toHaveLength(1);
    closeEventStore(store);
  });

  it('reads summaries through a read-only connection with a busy timeout', async () => {
    const fakeSqlite = createFakeSqliteModule({
      "SELECT value FROM meta WHERE key = 'schemaVersion'": { value: EVENT_STORE_SCHEMA_VERSION },
      'SELECT COUNT(*) AS count FROM events': { count: 5 },
    });

    await expect(readEventStoreSummary('/tmp/events.db', async () => fakeSqlite)).resolves.toEqual({
      eventCount: 5,
      schemaVersion: EVENT_STORE_SCHEMA_VERSION,
    });
    expect(fakeSqlite.constructorCalls).toEqual([
      {
        filePath: '/tmp/events.db',
        options: { readOnly: true, timeout: 2_000 },
      },
    ]);
    expect(fakeSqlite.closeCalls).toBe(1);
  });

  it('summarizes a real store without mutating it', async () => {
    const store = await createTempStore('event-store-summary-');
    const dbPath = store.filePath;

    try {
      replaceCodexFile(store);
    } finally {
      closeEventStore(store);
    }

    await expect(readEventStoreSummary(dbPath)).resolves.toEqual({
      eventCount: 1,
      schemaVersion: EVENT_STORE_SCHEMA_VERSION,
    });
  });

  it('round-trips optional event fields', async () => {
    const store = await createTempStore('event-store-optional-fields-');
    const event = createEvent({
      repoRoot: '/workspace/repo',
      provider: 'OpenAI-Codex',
      model: ' GPT-4.1 ',
      costUsd: 0.12,
      costMode: 'explicit',
    });

    try {
      replaceCodexFile(store, { events: [event] });

      expect(readFileEvents(store, 'codex', '/tmp/session.jsonl')).toEqual([
        createEvent({
          repoRoot: '/workspace/repo',
          provider: 'openai',
          model: 'gpt-4.1',
          costUsd: 0.12,
          costMode: 'explicit',
        }),
      ]);
    } finally {
      closeEventStore(store);
    }
  });
});
