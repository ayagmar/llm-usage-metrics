import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  openEventStore,
  replaceFileEvents,
  type EventStore,
  type EventStoreFileFingerprint,
} from '../../src/persistence/event-store.js';
import { loadHistoryEvents } from '../../src/persistence/event-store-history.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function createEvent(overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {}) {
  return createUsageEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp: '2026-02-14T10:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4.1',
    repoRoot: '/workspace/repo',
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 15,
    costMode: 'explicit',
    costUsd: 0.03,
    ...overrides,
  });
}

function createFingerprint(filePath: string): EventStoreFileFingerprint {
  return {
    dependencies: [{ path: filePath, exists: true, size: 10, mtimeMs: 20 }],
  };
}

async function createTempStore(): Promise<EventStore> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-history-'));
  tempDirs.push(tempDir);
  return openEventStore(path.join(tempDir, 'events.db'));
}

function writeStoredFile(
  store: EventStore,
  options: {
    source?: string;
    filePath: string;
    events: ReturnType<typeof createEvent>[];
    now?: number;
  },
): void {
  replaceFileEvents(store, {
    source: options.source ?? 'codex',
    filePath: options.filePath,
    fingerprint: createFingerprint(options.filePath),
    events: options.events,
    skippedRows: 0,
    now: options.now ?? 1_000,
  });
}

describe('event-store history', () => {
  it('serves events from a deleted unique file', async () => {
    const store = await createTempStore();
    const deletedEvent = createEvent({ sessionId: 'deleted' });

    try {
      writeStoredFile(store, { filePath: '/tmp/deleted.jsonl', events: [deletedEvent] });

      const result = loadHistoryEvents(store, {
        selectedSources: ['codex'],
        discoveredFiles: [],
      });

      expect(result).toMatchObject({
        departedFileCount: 1,
        servedFileCount: 1,
        suppressedFileCount: 0,
        servedEventCount: 1,
      });
      expect(result.events).toEqual([deletedEvent]);
    } finally {
      closeEventStore(store);
    }
  });

  it('suppresses a moved file with identical content under a new session id', async () => {
    const store = await createTempStore();
    const oldPathEvent = createEvent({ sessionId: 'old-path-session' });
    const newPathEvent = createEvent({ sessionId: 'new-path-session' });

    try {
      writeStoredFile(store, { filePath: '/tmp/old.jsonl', events: [oldPathEvent], now: 1_000 });
      writeStoredFile(store, { filePath: '/tmp/new.jsonl', events: [newPathEvent], now: 2_000 });

      const result = loadHistoryEvents(store, {
        selectedSources: ['codex'],
        discoveredFiles: [{ source: 'codex', filePath: '/tmp/new.jsonl' }],
      });

      expect(result.events).toEqual([]);
      expect(result).toMatchObject({
        departedFileCount: 1,
        servedFileCount: 0,
        suppressedFileCount: 1,
        servedEventCount: 0,
      });
    } finally {
      closeEventStore(store);
    }
  });

  it('suppresses a moved file after the live copy grows', async () => {
    const store = await createTempStore();
    const oldEvent = createEvent({ sessionId: 'old-path-session' });
    const movedEvent = createEvent({ sessionId: 'new-path-session' });
    const appendedEvent = createEvent({
      sessionId: 'new-path-session',
      timestamp: '2026-02-14T10:01:00.000Z',
      inputTokens: 20,
      totalTokens: 25,
    });

    try {
      writeStoredFile(store, { filePath: '/tmp/old.jsonl', events: [oldEvent], now: 1_000 });
      writeStoredFile(store, {
        filePath: '/tmp/new.jsonl',
        events: [movedEvent, appendedEvent],
        now: 2_000,
      });

      const result = loadHistoryEvents(store, {
        selectedSources: ['codex'],
        discoveredFiles: [{ source: 'codex', filePath: '/tmp/new.jsonl' }],
      });

      expect(result.events).toEqual([]);
      expect(result.suppressedFileCount).toBe(1);
    } finally {
      closeEventStore(store);
    }
  });

  it('serves one departed file and suppresses a second identical departed copy', async () => {
    const store = await createTempStore();
    const firstCopyEvent = createEvent({ sessionId: 'copy-1' });
    const secondCopyEvent = createEvent({ sessionId: 'copy-2' });

    try {
      writeStoredFile(store, {
        filePath: '/tmp/copy-a.jsonl',
        events: [firstCopyEvent],
        now: 1_000,
      });
      writeStoredFile(store, {
        filePath: '/tmp/copy-b.jsonl',
        events: [secondCopyEvent],
        now: 2_000,
      });

      const result = loadHistoryEvents(store, {
        selectedSources: ['codex'],
        discoveredFiles: [],
      });

      expect(result.events).toEqual([firstCopyEvent]);
      expect(result).toMatchObject({
        departedFileCount: 2,
        servedFileCount: 1,
        suppressedFileCount: 1,
        servedEventCount: 1,
      });
    } finally {
      closeEventStore(store);
    }
  });

  it('serves a departed file whole when it only partially overlaps live data', async () => {
    const store = await createTempStore();
    const sharedDeletedEvent = createEvent({ sessionId: 'deleted' });
    const sharedLiveEvent = createEvent({ sessionId: 'live' });
    const uniqueDeletedEvent = createEvent({
      sessionId: 'deleted',
      timestamp: '2026-02-14T10:02:00.000Z',
      inputTokens: 30,
      totalTokens: 35,
    });

    try {
      writeStoredFile(store, {
        filePath: '/tmp/deleted.jsonl',
        events: [sharedDeletedEvent, uniqueDeletedEvent],
        now: 1_000,
      });
      writeStoredFile(store, {
        filePath: '/tmp/live.jsonl',
        events: [sharedLiveEvent],
        now: 2_000,
      });

      const result = loadHistoryEvents(store, {
        selectedSources: ['codex'],
        discoveredFiles: [{ source: 'codex', filePath: '/tmp/live.jsonl' }],
      });

      expect(result.events).toEqual([sharedDeletedEvent, uniqueDeletedEvent]);
      expect(result).toMatchObject({
        departedFileCount: 1,
        servedFileCount: 1,
        suppressedFileCount: 0,
        servedEventCount: 2,
      });
    } finally {
      closeEventStore(store);
    }
  });

  it('ignores departed files from sources that were not selected', async () => {
    const store = await createTempStore();

    try {
      writeStoredFile(store, {
        source: 'codex',
        filePath: '/tmp/codex.jsonl',
        events: [createEvent({ source: 'codex' })],
      });

      const result = loadHistoryEvents(store, {
        selectedSources: ['pi'],
        discoveredFiles: [],
      });

      expect(result).toEqual({
        events: [],
        departedFileCount: 0,
        servedFileCount: 0,
        suppressedFileCount: 0,
        servedEventCount: 0,
      });
    } finally {
      closeEventStore(store);
    }
  });

  it('serves the valid rows of a departed file without deleting the invalid row', async () => {
    const store = await createTempStore();
    const validEvent = createEvent({ sessionId: 'valid' });
    const invalidEvent = createEvent({ sessionId: 'invalid' });

    try {
      writeStoredFile(store, {
        filePath: '/tmp/departed.jsonl',
        events: [validEvent, invalidEvent],
      });
      store.database
        .prepare("UPDATE events SET cost_mode = 'bogus' WHERE session_id = ?")
        .run('invalid');

      const result = loadHistoryEvents(store, {
        selectedSources: ['codex'],
        discoveredFiles: [],
      });

      expect(result.events).toEqual([validEvent]);
      expect(result).toMatchObject({
        departedFileCount: 1,
        servedFileCount: 1,
        suppressedFileCount: 0,
        servedEventCount: 1,
      });
      expect(store.database.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({
        count: 2,
      });
      expect(store.database.prepare('SELECT COUNT(*) AS count FROM files').get()).toEqual({
        count: 1,
      });
    } finally {
      closeEventStore(store);
    }
  });

  it('serves a departed file with a null content hash instead of crashing', async () => {
    const store = await createTempStore();
    const deletedEvent = createEvent({ sessionId: 'deleted' });

    try {
      writeStoredFile(store, { filePath: '/tmp/deleted.jsonl', events: [deletedEvent] });
      store.database
        .prepare('UPDATE events SET content_hash = NULL WHERE file_path = ?')
        .run('/tmp/deleted.jsonl');

      const result = loadHistoryEvents(store, {
        selectedSources: ['codex'],
        discoveredFiles: [],
      });

      expect(result.events).toEqual([deletedEvent]);
      expect(result).toMatchObject({
        departedFileCount: 1,
        servedFileCount: 1,
        suppressedFileCount: 0,
        servedEventCount: 1,
      });
    } finally {
      closeEventStore(store);
    }
  });
});
