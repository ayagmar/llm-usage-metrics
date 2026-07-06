import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  closeEventStore,
  countEvents,
  getDefaultEventStorePath,
  getFileEntry,
  openEventStore,
  readEventStoreSummary,
  readFileEvents,
  replaceFileEvents,
  serializeEventStoreFingerprint,
  type EventStore,
  type EventStoreFileFingerprint,
} from '../../src/persistence/event-store.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';

const tempDirs: string[] = [];

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
      ).toEqual({ value: '1' });
    } finally {
      closeEventStore(store);
    }
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

  it('recreates schema on version mismatch', async () => {
    const store = await createTempStore('event-store-version-');
    const dbPath = store.filePath;

    try {
      replaceCodexFile(store);
      store.database.prepare("UPDATE meta SET value = '999' WHERE key = 'schemaVersion'").run();
    } finally {
      closeEventStore(store);
    }

    const reopened = await openEventStore(dbPath);

    try {
      expect(countEvents(reopened)).toBe(0);
      expect(
        reopened.database.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get(),
      ).toEqual({ value: '1' });
    } finally {
      closeEventStore(reopened);
    }
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

  it('reads summaries through a read-only connection with a busy timeout', async () => {
    const fakeSqlite = createFakeSqliteModule({
      "SELECT value FROM meta WHERE key = 'schemaVersion'": { value: '1' },
      'SELECT COUNT(*) AS count FROM events': { count: 5 },
    });

    await expect(readEventStoreSummary('/tmp/events.db', async () => fakeSqlite)).resolves.toEqual({
      eventCount: 5,
      schemaVersion: '1',
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
      schemaVersion: '1',
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
