import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  normalizeStoredEvent,
  openEventStore,
  replaceFileEvents,
  type EventStore,
  type EventStoreFileFingerprint,
} from '../../src/persistence/event-store.js';
import {
  classifyDepartedFiles,
  loadHistoryEvents,
} from '../../src/persistence/event-store-history.js';
import { compareByCodePoint } from '../../src/utils/compare-by-code-point.js';

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

// Wraps store.database so every prepare/exec call and every prepared-statement
// execution (all/get/run) increments a shared counter. Lets a test observe that
// loadHistoryEvents issues a bounded number of queries as departed files grow.
function countStoreQueries(store: EventStore): { getCount: () => number } {
  const real = store.database;
  let count = 0;
  const wrap = (statement: ReturnType<typeof real.prepare>) => ({
    all: (...args: unknown[]) => {
      count += 1;
      return statement.all(...args);
    },
    get: (...args: unknown[]) => {
      count += 1;
      return statement.get(...args);
    },
    run: (...args: unknown[]) => {
      count += 1;
      return statement.run(...args);
    },
    setReturnArrays: (enabled: boolean) => {
      statement.setReturnArrays(enabled);
    },
  });

  store.database = {
    exec: (sql: string) => {
      count += 1;
      real.exec(sql);
    },
    prepare: (sql: string) => {
      count += 1;
      return wrap(real.prepare(sql));
    },
    close: () => {
      real.close();
    },
  };

  return { getCount: () => count };
}

type ReferenceMultiset = { counts: Map<string, number>; hasNullHash: boolean };

// Independent reimplementation of the per-file classification the batched code
// replaces, reading straight from stored rows. The batched result must match it.
function referenceMultiset(store: EventStore, source: string, filePath: string): ReferenceMultiset {
  const rows = store.database
    .prepare(
      'SELECT content_hash AS content_hash, COUNT(*) AS count FROM events WHERE source = ? AND file_path = ? GROUP BY content_hash',
    )
    .all(source, filePath);
  const counts = new Map<string, number>();
  let hasNullHash = false;

  for (const row of rows) {
    const hash = typeof row.content_hash === 'string' ? row.content_hash.trim() : '';

    if (!hash) {
      hasNullHash = true;
      continue;
    }

    const count = Number(row.count);
    if (count > 0) {
      counts.set(hash, (counts.get(hash) ?? 0) + count);
    }
  }

  return { counts, hasNullHash };
}

function referenceIsSubset(file: ReferenceMultiset, served: Map<string, number>): boolean {
  if (file.hasNullHash) {
    return false;
  }

  for (const [hash, count] of file.counts) {
    if (count > (served.get(hash) ?? 0)) {
      return false;
    }
  }

  return true;
}

// All fixtures below leave every stored file departed (discoveredFiles = []), so
// the served multiset starts empty and this reference mirrors production exactly.
function referenceHistory(store: EventStore, source: string) {
  const files = store.database
    .prepare(
      'SELECT source AS source, file_path AS file_path, ingested_at AS ingested_at FROM files WHERE source = ?',
    )
    .all(source)
    .map((row) => ({
      source: String(row.source),
      filePath: String(row.file_path),
      ingestedAt: Number(row.ingested_at),
    }))
    .sort((left, right) => {
      if (left.ingestedAt !== right.ingestedAt) {
        return left.ingestedAt - right.ingestedAt;
      }
      if (left.filePath !== right.filePath) {
        return compareByCodePoint(left.filePath, right.filePath);
      }
      return compareByCodePoint(left.source, right.source);
    });

  const served = new Map<string, number>();
  const servedFiles: { source: string; filePath: string }[] = [];
  let suppressedFileCount = 0;

  for (const file of files) {
    const multiset = referenceMultiset(store, file.source, file.filePath);

    if (referenceIsSubset(multiset, served)) {
      suppressedFileCount += 1;
      continue;
    }

    for (const [hash, count] of multiset.counts) {
      served.set(hash, (served.get(hash) ?? 0) + count);
    }
    servedFiles.push({ source: file.source, filePath: file.filePath });
  }

  const selectEvents = store.database.prepare(
    'SELECT source, session_id, timestamp, model, provider, repo_root, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, cost_mode FROM events WHERE source = ? AND file_path = ? ORDER BY event_index ASC',
  );
  const events: UsageEvent[] = [];

  for (const file of servedFiles) {
    for (const row of selectEvents.all(file.source, file.filePath)) {
      const event = normalizeStoredEvent(row);
      if (event) {
        events.push(event);
      }
    }
  }

  return {
    events,
    departedFileCount: files.length,
    servedFileCount: servedFiles.length,
    suppressedFileCount,
    servedEventCount: events.length,
  };
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

  it('serves a departed file whose events differ from live data only by session id', async () => {
    const store = await createTempStore();
    const departedEvent = createEvent({ sessionId: 'departed-session' });
    const liveEvent = createEvent({ sessionId: 'live-session' });

    try {
      writeStoredFile(store, {
        filePath: '/tmp/departed.jsonl',
        events: [departedEvent],
        now: 1_000,
      });
      writeStoredFile(store, { filePath: '/tmp/live.jsonl', events: [liveEvent], now: 2_000 });

      const result = loadHistoryEvents(store, {
        selectedSources: ['codex'],
        discoveredFiles: [{ source: 'codex', filePath: '/tmp/live.jsonl' }],
      });

      expect(result.events).toEqual([departedEvent]);
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

  it('suppresses a moved file with identical content under the same session id', async () => {
    const store = await createTempStore();
    const oldPathEvent = createEvent({ sessionId: 'moved-session' });
    const newPathEvent = createEvent({ sessionId: 'moved-session' });

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
    const oldEvent = createEvent({ sessionId: 'moved-session' });
    const movedEvent = createEvent({ sessionId: 'moved-session' });
    const appendedEvent = createEvent({
      sessionId: 'moved-session',
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
    const firstCopyEvent = createEvent({ sessionId: 'copied-session' });
    const secondCopyEvent = createEvent({ sessionId: 'copied-session' });

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

  it('classifies departed files with suppression state and newest timestamps', async () => {
    const store = await createTempStore();
    const servedEvent = createEvent({
      sessionId: 'served',
      timestamp: '2026-02-14T10:00:00.000Z',
    });
    const servedNewestEvent = createEvent({
      sessionId: 'served',
      timestamp: '2026-02-15T11:00:00.000Z',
      inputTokens: 20,
      totalTokens: 25,
    });
    const oldPathEvent = createEvent({ sessionId: 'moved-session' });
    const livePathEvent = createEvent({ sessionId: 'moved-session' });

    try {
      writeStoredFile(store, {
        filePath: '/tmp/served.jsonl',
        events: [servedEvent, servedNewestEvent],
        now: 1_000,
      });
      writeStoredFile(store, {
        filePath: '/tmp/old.jsonl',
        events: [oldPathEvent],
        now: 2_000,
      });
      writeStoredFile(store, {
        filePath: '/tmp/live.jsonl',
        events: [livePathEvent],
        now: 3_000,
      });

      const input = {
        selectedSources: ['codex'],
        discoveredFiles: [{ source: 'codex', filePath: '/tmp/live.jsonl' }],
      };
      const classifiedFiles = classifyDepartedFiles(store, input);
      const history = loadHistoryEvents(store, input);

      expect(classifiedFiles).toEqual([
        {
          source: 'codex',
          filePath: '/tmp/served.jsonl',
          eventCount: 2,
          newestTimestamp: '2026-02-15T11:00:00.000Z',
          suppressed: false,
        },
        {
          source: 'codex',
          filePath: '/tmp/old.jsonl',
          eventCount: 1,
          newestTimestamp: '2026-02-14T10:00:00.000Z',
          suppressed: true,
        },
      ]);
      expect(history.servedFileCount).toBe(
        classifiedFiles.filter((file) => !file.suppressed).length,
      );
      expect(history.suppressedFileCount).toBe(
        classifiedFiles.filter((file) => file.suppressed).length,
      );
    } finally {
      closeEventStore(store);
    }
  });

  it('serves a departed file whole when it only partially overlaps live data', async () => {
    const store = await createTempStore();
    const sharedDeletedEvent = createEvent({ sessionId: 'shared' });
    const sharedLiveEvent = createEvent({ sessionId: 'shared' });
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

  it('issues a bounded number of queries per history load regardless of departed count', async () => {
    const runLoad = async (fileCount: number): Promise<number> => {
      const store = await createTempStore();

      try {
        for (let index = 0; index < fileCount; index += 1) {
          writeStoredFile(store, {
            filePath: `/tmp/departed-${index}.jsonl`,
            events: [
              createEvent({
                sessionId: `session-${index}`,
                inputTokens: 100 + index,
                totalTokens: 105 + index,
              }),
            ],
            now: 1_000 + index,
          });
        }

        const counter = countStoreQueries(store);
        loadHistoryEvents(store, { selectedSources: ['codex'], discoveredFiles: [] });
        return counter.getCount();
      } finally {
        closeEventStore(store);
      }
    };

    const smallCount = await runLoad(25);
    const largeCount = await runLoad(250);

    expect(smallCount).toBe(largeCount);
    expect(smallCount).toBe(16);
  });

  it('matches the per-file reference on a large overlapping/moved/copied fixture', async () => {
    const store = await createTempStore();
    let now = 1_000;
    const write = (filePath: string, events: ReturnType<typeof createEvent>[]) => {
      writeStoredFile(store, { filePath, events, now });
      now += 1;
    };
    const partialTimestamp = '2026-02-14T10:03:00.000Z';

    try {
      // Unique single-event files — each served.
      for (let index = 0; index < 60; index += 1) {
        write(`/tmp/base-${index}.jsonl`, [
          createEvent({
            sessionId: `base-${index}`,
            inputTokens: 100 + index,
            totalTokens: 105 + index,
          }),
        ]);
      }
      // Exact copies (same session ids) — suppressed.
      for (let index = 0; index < 60; index += 1) {
        write(`/tmp/copy-${index}.jsonl`, [
          createEvent({
            sessionId: `base-${index}`,
            inputTokens: 100 + index,
            totalTokens: 105 + index,
          }),
        ]);
      }
      // Partial overlap (shared + unique event) — served whole.
      for (let index = 0; index < 50; index += 1) {
        write(`/tmp/partial-${index}.jsonl`, [
          createEvent({
            sessionId: `ps-${index}`,
            inputTokens: 100 + index,
            totalTokens: 105 + index,
          }),
          createEvent({
            sessionId: `pu-${index}`,
            inputTokens: 900 + index,
            totalTokens: 905 + index,
            timestamp: partialTimestamp,
          }),
        ]);
      }
      // Copies of the partial files — both hashes already served, suppressed.
      for (let index = 0; index < 50; index += 1) {
        write(`/tmp/partial-copy-${index}.jsonl`, [
          createEvent({
            sessionId: `ps-${index}`,
            inputTokens: 100 + index,
            totalTokens: 105 + index,
          }),
          createEvent({
            sessionId: `pu-${index}`,
            inputTokens: 900 + index,
            totalTokens: 905 + index,
            timestamp: partialTimestamp,
          }),
        ]);
      }
      // Three identical events of a fresh content — served (multiset count 3).
      for (let index = 0; index < 30; index += 1) {
        const duplicate = () =>
          createEvent({
            sessionId: `dup-${index}`,
            inputTokens: 2_000 + index,
            totalTokens: 2_005 + index,
          });
        write(`/tmp/dup-${index}.jsonl`, [duplicate(), duplicate(), duplicate()]);
      }
      // One event of that content — count 1 <= served 3, suppressed.
      for (let index = 0; index < 30; index += 1) {
        write(`/tmp/dup-single-${index}.jsonl`, [
          createEvent({
            sessionId: `dup-${index}`,
            inputTokens: 2_000 + index,
            totalTokens: 2_005 + index,
          }),
        ]);
      }
      // Four events of that content — count 4 > served 3, served whole.
      for (let index = 0; index < 20; index += 1) {
        const duplicate = () =>
          createEvent({
            sessionId: `dup-${index}`,
            inputTokens: 2_000 + index,
            totalTokens: 2_005 + index,
          });
        write(`/tmp/dup-more-${index}.jsonl`, [duplicate(), duplicate(), duplicate(), duplicate()]);
      }

      const reference = referenceHistory(store, 'codex');
      const result = loadHistoryEvents(store, { selectedSources: ['codex'], discoveredFiles: [] });

      expect(reference.departedFileCount).toBe(300);
      expect(reference.suppressedFileCount).toBeGreaterThan(0);
      expect(reference.servedFileCount).toBeGreaterThan(0);
      expect(result.departedFileCount).toBe(reference.departedFileCount);
      expect(result.servedFileCount).toBe(reference.servedFileCount);
      expect(result.suppressedFileCount).toBe(reference.suppressedFileCount);
      expect(result.servedEventCount).toBe(reference.servedEventCount);
      expect(result.events).toEqual(reference.events);
    } finally {
      closeEventStore(store);
    }
  });

  it('serves events in order across the served-file insert chunk boundary', async () => {
    const store = await createTempStore();
    const servedCount = 550; // > one 500-file insert chunk

    try {
      for (let index = 0; index < servedCount; index += 1) {
        writeStoredFile(store, {
          filePath: `/tmp/served-${index}.jsonl`,
          events: [
            createEvent({
              sessionId: `served-${index}`,
              inputTokens: 100 + index,
              totalTokens: 105 + index,
            }),
          ],
          now: 1_000 + index,
        });
      }

      const reference = referenceHistory(store, 'codex');
      const result = loadHistoryEvents(store, { selectedSources: ['codex'], discoveredFiles: [] });

      expect(result.servedFileCount).toBe(servedCount);
      expect(result.servedEventCount).toBe(servedCount);
      expect(result.events).toEqual(reference.events);
      // Ordinal ordering must hold across the chunk boundary (index 499 -> 500).
      expect(result.events.map((event) => event.sessionId)).toEqual(
        Array.from({ length: servedCount }, (_unused, index) => `served-${index}`),
      );
    } finally {
      closeEventStore(store);
    }
  });

  it('never suppresses a null-hash departed file among many departed files', async () => {
    const store = await createTempStore();
    let now = 1_000;

    try {
      for (let index = 0; index < 10; index += 1) {
        writeStoredFile(store, {
          filePath: `/tmp/other-${index}.jsonl`,
          events: [
            createEvent({
              sessionId: `other-${index}`,
              inputTokens: 300 + index,
              totalTokens: 305 + index,
            }),
          ],
          now: (now += 1),
        });
      }
      // Content identical to other-0, so a non-null hash would be suppressed.
      writeStoredFile(store, {
        filePath: '/tmp/nullish.jsonl',
        events: [createEvent({ sessionId: 'other-0', inputTokens: 300, totalTokens: 305 })],
        now: (now += 1),
      });
      store.database
        .prepare('UPDATE events SET content_hash = NULL WHERE file_path = ?')
        .run('/tmp/nullish.jsonl');

      const input = { selectedSources: ['codex'], discoveredFiles: [] };
      const classified = classifyDepartedFiles(store, input);
      const result = loadHistoryEvents(store, input);

      const nullFile = classified.find((file) => file.filePath === '/tmp/nullish.jsonl');
      expect(nullFile?.suppressed).toBe(false);
      // Served twice: once from other-0 and once from the null-hash copy.
      expect(result.events.filter((event) => event.inputTokens === 300)).toHaveLength(2);
    } finally {
      closeEventStore(store);
    }
  });

  it('suppresses an empty departed file (zero events) among populated files', async () => {
    const store = await createTempStore();

    try {
      writeStoredFile(store, { filePath: '/tmp/empty.jsonl', events: [], now: 1_000 });
      writeStoredFile(store, {
        filePath: '/tmp/full.jsonl',
        events: [createEvent({ sessionId: 'full', inputTokens: 400, totalTokens: 405 })],
        now: 2_000,
      });

      const classified = classifyDepartedFiles(store, {
        selectedSources: ['codex'],
        discoveredFiles: [],
      });

      const emptyFile = classified.find((file) => file.filePath === '/tmp/empty.jsonl');
      expect(emptyFile?.eventCount).toBe(0);
      expect(emptyFile?.suppressed).toBe(true);
    } finally {
      closeEventStore(store);
    }
  });
});
