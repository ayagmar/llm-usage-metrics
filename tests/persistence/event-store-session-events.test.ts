import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile as writeTextFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  computeEventContentHash,
  createMessageEvent,
  createToolCallEvent,
  type MessageEvent,
} from '@ayagmar/agent-sessions';
import { loadNodeSqliteModule } from '@ayagmar/agent-sessions/internal';
import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  deleteStoredFiles,
  EventStoreSchemaVersionError,
  getFileEntry,
  migrateSchemaV4ToV5,
  openEventStore,
  readEventStoreEvents,
  readEventStoreSummary,
  readFileEvents,
  readStoredSessionEvents,
  replaceFilesEvents,
  serializeEventStoreFingerprint,
  type EventStore,
  type StoredSessionEvent,
} from '../../src/persistence/event-store.js';
import type {
  EventStoreSqliteModule,
  EventStoreStatement,
} from '../../src/persistence/event-store-database.js';
import { writeV4Store } from '../helpers/event-store-v4.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStorePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'event-store-session-events-'));
  tempDirs.push(dir);
  return path.join(dir, 'events.db');
}

function sourceUrl(fileName: string): string {
  return pathToFileURL(path.resolve('src/persistence', fileName)).href;
}

const FINGERPRINT = {
  dependencies: [{ path: '/logs/a.jsonl', exists: true, size: 1, mtimeMs: 2 }],
};

function usageEvent(sessionId = 'session-1') {
  return createUsageEvent({
    source: 'codex',
    sessionId,
    timestamp: '2026-02-01T00:00:00.000Z',
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    costMode: 'estimated',
  });
}

function toolCall(overrides: Partial<Parameters<typeof createToolCallEvent>[0]> = {}) {
  return createToolCallEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp: '2026-02-01T00:00:01.000Z',
    name: 'exec_command',
    status: 'ok',
    ...overrides,
  });
}

function message(overrides: Partial<Parameters<typeof createMessageEvent>[0]> = {}) {
  return createMessageEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp: '2026-02-01T00:00:02.000Z',
    role: 'user',
    textLength: 12,
    ...overrides,
  });
}

function writeFile(
  store: EventStore,
  filePath: string,
  sessionEvents: readonly StoredSessionEvent[],
  events = [usageEvent()],
): void {
  replaceFilesEvents(store, [
    {
      source: 'codex',
      filePath,
      fingerprint: FINGERPRINT,
      events,
      sessionEvents,
      skippedRows: 0,
      now: 1,
    },
  ]);
}

function countRows(store: EventStore, table: 'tool_calls' | 'messages' | 'files'): number {
  return Number(store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count);
}

async function createV4Store(filePath: string): Promise<void> {
  await writeV4Store(filePath, [
    {
      source: 'codex',
      filePath: '/logs/a.jsonl',
      fingerprint: serializeEventStoreFingerprint(FINGERPRINT),
      events: [usageEvent('a'), usageEvent('b')],
    },
  ]);
}

describe('stored tool calls and messages', () => {
  it('reads back what was written, in the order the adapter yielded it, without text', async () => {
    const storePath = await createStorePath();
    const store = await openEventStore(storePath);
    const events: StoredSessionEvent[] = [
      message({ messageId: 'm1' }),
      toolCall({
        toolCallId: 'call-1',
        status: 'error',
        completedAt: '2026-02-01T00:00:03.000Z',
        durationMs: 40,
        messageId: 'm2',
      }),
      message({ role: 'assistant', model: 'gpt-5', textLength: 0 }),
      toolCall({ name: 'apply_patch', status: 'unknown' }),
    ];

    try {
      writeFile(store, '/logs/a.jsonl', [
        { ...events[0], text: 'private' } as MessageEvent,
        ...events.slice(1),
      ]);
      writeFile(store, '/logs/b.jsonl', [toolCall({ sessionId: 'session-2' })]);
    } finally {
      closeEventStore(store);
    }

    const files = [
      { source: 'codex', filePath: '/logs/a.jsonl' },
      { source: 'codex', filePath: '/logs/missing.jsonl' },
      { source: 'codex', filePath: '/logs/b.jsonl' },
    ];
    const both = await readStoredSessionEvents(storePath, files, new Set(['tool_call', 'message']));
    const toolCallsOnly = await readStoredSessionEvents(storePath, files, new Set(['tool_call']));

    expect(both.map((fileEvents) => fileEvents.map((event) => JSON.stringify(event)))).toEqual([
      events.map((event) => JSON.stringify(event)),
      [],
      [JSON.stringify(toolCall({ sessionId: 'session-2' }))],
    ]);
    expect(toolCallsOnly[0]).toEqual([events[1], events[3]]);
    expect(await readStoredSessionEvents(storePath, files, new Set())).toEqual([[], [], []]);
  });

  it('replaces a file’s rows on rewrite and deletes them with the file', async () => {
    const store = await openEventStore(await createStorePath());

    try {
      writeFile(store, '/logs/a.jsonl', [toolCall(), message(), toolCall()]);
      writeFile(store, '/logs/b.jsonl', [toolCall()]);
      writeFile(store, '/logs/a.jsonl', [message()]);
      writeFile(store, '/logs/c.jsonl', [toolCall()]);
      writeFile(store, '/logs/c.jsonl', []);

      expect([countRows(store, 'tool_calls'), countRows(store, 'messages')]).toEqual([1, 1]);
      expect(countRows(store, 'files')).toBe(3);
      expect(
        deleteStoredFiles(store, [
          { source: 'codex', filePath: '/logs/a.jsonl' },
          { source: 'codex', filePath: '/logs/b.jsonl' },
        ]),
      ).toEqual({ deletedFileCount: 2, deletedEventCount: 4 });
      expect([countRows(store, 'tool_calls'), countRows(store, 'messages')]).toEqual([0, 0]);
      expect(countRows(store, 'files')).toBe(1);
    } finally {
      closeEventStore(store);
    }
  });

  it('drops a file’s tool calls and messages with a corrupt usage row', async () => {
    const store = await openEventStore(await createStorePath());

    try {
      writeFile(store, '/logs/a.jsonl', [toolCall(), message()]);
      store.database.prepare("UPDATE events SET cost_mode = 'broken'").run();

      expect(readFileEvents(store, 'codex', '/logs/a.jsonl')).toBeUndefined();
      expect([countRows(store, 'tool_calls'), countRows(store, 'messages')]).toEqual([0, 0]);
    } finally {
      closeEventStore(store);
    }
  });

  it('skips a stored row the event constructors reject', async () => {
    const storePath = await createStorePath();
    const store = await openEventStore(storePath);

    try {
      writeFile(store, '/logs/a.jsonl', [
        toolCall({ name: 'bad' }),
        toolCall({ name: 'late' }),
        toolCall({ name: 'text' }),
        toolCall(),
        message(),
      ]);
      store.database.prepare("UPDATE tool_calls SET status = 'broken' WHERE name = 'bad'").run();
      // Past the last date a Date holds, and a timestamp stored as text.
      store.database.prepare("UPDATE tool_calls SET timestamp = 9e15 WHERE name = 'late'").run();
      store.database.prepare("UPDATE tool_calls SET timestamp = 'x' WHERE name = 'text'").run();
      store.database.prepare("UPDATE messages SET role = 'tool'").run();
    } finally {
      closeEventStore(store);
    }

    const [events] = await readStoredSessionEvents(
      storePath,
      [{ source: 'codex', filePath: '/logs/a.jsonl' }],
      new Set(['tool_call', 'message']),
    );

    expect(events).toEqual([toolCall()]);
  });

  it('counts tool calls and messages in the summary', async () => {
    const storePath = await createStorePath();
    const store = await openEventStore(storePath);

    try {
      writeFile(store, '/logs/a.jsonl', [toolCall(), toolCall(), message()]);
    } finally {
      closeEventStore(store);
    }

    await expect(readEventStoreSummary(storePath)).resolves.toEqual({
      eventCount: 1,
      toolCallCount: 2,
      messageCount: 1,
      schemaVersion: '5',
    });
  });

  it('keys a fingerprint by the stored kinds only when there are some', () => {
    expect(serializeEventStoreFingerprint(FINGERPRINT)).toBe(
      '{"dependencies":[{"path":"/logs/a.jsonl","exists":true,"size":1,"mtimeMs":2}]}',
    );
    expect(
      serializeEventStoreFingerprint({
        parserVersion: 'n1.p2',
        storedKinds: ['tool_call', 'message', 'tool_call'],
        ...FINGERPRINT,
      }),
    ).toBe(
      '{"parserVersion":"n1.p2","storedKinds":["message","tool_call"],"dependencies":[{"path":"/logs/a.jsonl","exists":true,"size":1,"mtimeMs":2}]}',
    );
    expect(serializeEventStoreFingerprint({ storedKinds: [], ...FINGERPRINT })).toBe(
      serializeEventStoreFingerprint(FINGERPRINT),
    );
  });
});

describe('schema v5 migration', () => {
  it('migrates a v4 store with rows, keeping its usage events and files', async () => {
    const storePath = await createStorePath();
    await createV4Store(storePath);

    // A read-only reader never migrates: the v4 store has no tool call tables to read.
    await expect(
      readStoredSessionEvents(storePath, [], new Set(['tool_call'])),
    ).rejects.toBeInstanceOf(EventStoreSchemaVersionError);
    await expect(readEventStoreSummary(storePath)).resolves.toEqual({
      eventCount: 2,
      toolCallCount: 0,
      messageCount: 0,
      schemaVersion: '4',
    });

    const store = await openEventStore(storePath);

    try {
      expect(readFileEvents(store, 'codex', '/logs/a.jsonl')).toEqual([
        usageEvent('a'),
        usageEvent('b'),
      ]);
      writeFile(store, '/logs/b.jsonl', [toolCall()]);
    } finally {
      closeEventStore(store);
    }

    await expect(readEventStoreSummary(storePath)).resolves.toEqual({
      eventCount: 3,
      toolCallCount: 1,
      messageCount: 0,
      schemaVersion: '5',
    });
  });

  it('copies every v4 file and its events, in order and with their hashes', async () => {
    const storePath = await createStorePath();
    const events = [usageEvent('c'), usageEvent('a'), usageEvent('b')];
    const fingerprint = serializeEventStoreFingerprint(FINGERPRINT);
    await writeV4Store(storePath, [
      { source: 'codex', filePath: '/logs/b.jsonl', fingerprint, events },
      // A departed file history still lists, with no usage rows.
      { source: 'pi', filePath: '/logs/empty.jsonl', fingerprint, events: [], skippedRows: 2 },
    ]);
    const v4Read = await readEventStoreEvents(storePath);

    const store = await openEventStore(storePath);

    try {
      expect(readFileEvents(store, 'codex', '/logs/b.jsonl')).toEqual(events);
      expect(getFileEntry(store, 'pi', '/logs/empty.jsonl')).toMatchObject({ skippedRows: 2 });
      // History matches moved copies through the stored hashes and their index.
      expect(
        store.database.prepare('SELECT content_hash FROM events ORDER BY event_index').all(),
      ).toEqual(events.map((event) => ({ content_hash: computeEventContentHash(event) })));
      expect(
        store.database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
          .all(),
      ).toEqual([{ name: 'events_content_hash' }]);
    } finally {
      closeEventStore(store);
    }

    // A read-only reader reads the v4 layout as it reads the v5 one.
    expect(v4Read.events).toEqual(events);
    expect((await readEventStoreEvents(storePath)).events).toEqual(events);
  });

  it('returns the space of the v4 tables it copied', async () => {
    const storePath = await createStorePath();
    const fingerprint = serializeEventStoreFingerprint(FINGERPRINT);
    const events = Array.from({ length: 2_000 }, (_, index) => usageEvent(`session-${index}`));
    await writeV4Store(storePath, [
      { source: 'codex', filePath: '/logs/a.jsonl', fingerprint, events },
    ]);

    const store = await openEventStore(storePath);

    try {
      expect(store.database.prepare('PRAGMA freelist_count').get()).toEqual({
        freelist_count: 0,
      });
      expect(readFileEvents(store, 'codex', '/logs/a.jsonl')).toEqual(events);
    } finally {
      closeEventStore(store);
    }
  });

  it('reads a v4 store whole while another connection migrates it', async () => {
    const storePath = await createStorePath();
    const events = [usageEvent('a'), usageEvent('b')];
    const fingerprint = serializeEventStoreFingerprint(FINGERPRINT);
    await writeV4Store(storePath, [
      { source: 'codex', filePath: '/logs/a.jsonl', fingerprint, events },
    ]);
    const sqlite = (await loadNodeSqliteModule('Test')) as unknown as EventStoreSqliteModule;
    const migrator = new sqlite.DatabaseSync(storePath);
    let migrated = false;

    // The other connection commits the migration as soon as the reader has the version.
    class MigratedAfterVersionRead extends sqlite.DatabaseSync {
      override prepare = (sql: string): EventStoreStatement => {
        const statement = super.prepare(sql);

        if (sql === 'SELECT key, value FROM meta') {
          const all = statement.all.bind(statement);
          statement.all = (...parameters) => {
            const rows = all(...parameters);
            migrateSchemaV4ToV5(migrator);
            migrated = true;
            return rows;
          };
        }

        return statement;
      };
    }

    try {
      const read = await readEventStoreEvents(storePath, {}, () =>
        Promise.resolve({ DatabaseSync: MigratedAfterVersionRead }),
      );

      expect(migrated).toBe(true);
      expect(read.meta.get('schemaVersion')).toBe('4');
      expect(read.events).toEqual(events);
      expect((await readEventStoreEvents(storePath)).meta.get('schemaVersion')).toBe('5');
    } finally {
      migrator.close();
    }
  });

  it('opens a v4 store that another process migrates while this one waits', async () => {
    const storePath = await createStorePath();
    await createV4Store(storePath);

    // The other process takes the write lock, migrates, and commits after a pause.
    const migratorPath = path.join(path.dirname(storePath), 'migrator.mts');
    await writeTextFile(
      migratorPath,
      `
import { DatabaseSync } from 'node:sqlite';
import { runTransaction } from ${JSON.stringify(sourceUrl('event-store-database.ts'))};
import { migrateSchemaV4ToV5 } from ${JSON.stringify(sourceUrl('event-store-schema.ts'))};
const db = new DatabaseSync(process.argv[2]);
runTransaction(db, () => {
  migrateSchemaV4ToV5(db);
  process.stdout.write('locked\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
});
db.close();
`,
    );
    const migrator = spawn(process.execPath, ['--import', 'tsx', migratorPath, storePath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const exited = new Promise((resolve) => {
      migrator.on('exit', resolve);
    });
    await new Promise<void>((resolve) => {
      migrator.stdout.once('data', () => {
        resolve();
      });
    });

    const store = await openEventStore(storePath);

    try {
      expect(readFileEvents(store, 'codex', '/logs/a.jsonl')).toHaveLength(2);
      writeFile(store, '/logs/b.jsonl', [toolCall()]);
      expect(countRows(store, 'tool_calls')).toBe(1);
    } finally {
      closeEventStore(store);
    }

    expect(await exited).toBe(0);
    await expect(readEventStoreSummary(storePath)).resolves.toMatchObject({
      schemaVersion: '5',
    });
  });
});
