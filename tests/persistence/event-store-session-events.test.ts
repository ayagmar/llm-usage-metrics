import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createMessageEvent,
  createToolCallEvent,
  type MessageEvent,
} from '@ayagmar/agent-sessions';
import { afterEach, describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  deleteStoredFiles,
  EventStoreSchemaVersionError,
  openEventStore,
  readEventStoreSummary,
  readFileEvents,
  readStoredSessionEvents,
  replaceFilesEvents,
  serializeEventStoreFingerprint,
  type EventStore,
  type StoredSessionEvent,
} from '../../src/persistence/event-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStorePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'event-store-session-events-'));
  tempDirs.push(dir);
  return path.join(dir, 'events.db');
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

function countRows(store: EventStore, table: 'tool_calls' | 'messages'): number {
  return Number(store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count);
}

/** A v4 store: the v5 schema without the tables v5 added. */
async function createV4Store(filePath: string): Promise<void> {
  const store = await openEventStore(filePath);

  try {
    replaceFilesEvents(store, [
      {
        source: 'codex',
        filePath: '/logs/a.jsonl',
        fingerprint: FINGERPRINT,
        events: [usageEvent('a'), usageEvent('b')],
        skippedRows: 0,
        now: 1,
      },
    ]);
    store.database.exec('DROP TABLE tool_calls; DROP TABLE messages;');
    store.database.prepare("UPDATE meta SET value = '4' WHERE key = 'schemaVersion'").run();
  } finally {
    closeEventStore(store);
  }
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

      expect([countRows(store, 'tool_calls'), countRows(store, 'messages')]).toEqual([1, 1]);
      expect(
        deleteStoredFiles(store, [
          { source: 'codex', filePath: '/logs/a.jsonl' },
          { source: 'codex', filePath: '/logs/b.jsonl' },
        ]),
      ).toEqual({ deletedFileCount: 2, deletedEventCount: 4 });
      expect([countRows(store, 'tool_calls'), countRows(store, 'messages')]).toEqual([0, 0]);
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
      writeFile(store, '/logs/a.jsonl', [toolCall({ name: 'bad' }), toolCall(), message()]);
      store.database.prepare("UPDATE tool_calls SET status = 'broken' WHERE name = 'bad'").run();
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

  it('opens a v4 store that another process migrates while this one waits', async () => {
    const storePath = await createStorePath();
    await createV4Store(storePath);

    // The other process takes the write lock, migrates, and commits after a pause.
    const migrator = spawn(
      process.execPath,
      [
        '-e',
        `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN IMMEDIATE');
db.exec("CREATE TABLE tool_calls (source TEXT NOT NULL, file_path TEXT NOT NULL, event_index INTEGER NOT NULL, session_id TEXT NOT NULL, timestamp TEXT NOT NULL, tool_call_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, duration_ms INTEGER, message_id TEXT, PRIMARY KEY (source, file_path, event_index)) WITHOUT ROWID");
db.exec("CREATE TABLE messages (source TEXT NOT NULL, file_path TEXT NOT NULL, event_index INTEGER NOT NULL, session_id TEXT NOT NULL, timestamp TEXT NOT NULL, role TEXT NOT NULL, message_id TEXT, model TEXT, text_length INTEGER NOT NULL, PRIMARY KEY (source, file_path, event_index)) WITHOUT ROWID");
db.exec("UPDATE meta SET value = '5' WHERE key = 'schemaVersion'");
process.stdout.write('locked\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
db.exec('COMMIT');
db.close();
`,
        storePath,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
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
