import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseAdapterEvents,
  parseSelectedAdapters,
} from '../../src/cli/build-usage-data-parsing.js';
import type { ParseWorkerPool } from '../../src/cli/parse-worker-pool.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  openEventStore,
  serializeEventStoreFingerprint,
  type EventStore,
  type EventStoreFileEntry,
  type ReplaceFileEventsInput,
} from '../../src/persistence/event-store.js';
import type {
  SourceAdapter,
  SourceParseFileDiagnostics,
} from '../../src/sources/source-adapter.js';
import { RuntimeProfileCollector } from '../../src/cli/runtime-profile.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function createDelayedAdapter(
  id: string,
  filePath: string,
  stats: { current: number; max: number },
): SourceAdapter {
  return {
    id,
    discoverFiles: async () => [filePath],
    parseFile: async () => {
      stats.current += 1;
      stats.max = Math.max(stats.max, stats.current);

      try {
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });

        return [
          createUsageEvent({
            source: id,
            sessionId: `${id}-session`,
            timestamp: '2026-02-01T00:00:00.000Z',
            inputTokens: 1,
            totalTokens: 1,
          }),
        ];
      } finally {
        stats.current -= 1;
      }
    },
  };
}

function rejectWithUnknown(reason: unknown): Promise<never> {
  return (async () => {
    throw reason;
  })();
}

function createStoreBackedAdapter(id: string, files: string[]): SourceAdapter {
  return {
    id,
    discoverFiles: async () => files,
    parseFile: async (filePath) => [
      createUsageEvent({
        source: id,
        sessionId: path.basename(filePath, '.jsonl'),
        timestamp: '2026-02-01T00:00:00.000Z',
        inputTokens: 1,
        totalTokens: 1,
      }),
    ],
  };
}

function createCountingJsonlAdapter(
  id: string,
  files: string[],
  parseCallCounter: { count: number },
): SourceAdapter {
  return {
    id,
    discoverFiles: async () => files,
    parseFile: async (filePath) => {
      parseCallCounter.count += 1;
      const content = await readFile(filePath, 'utf8');
      const totalTokens =
        content
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0).length || 1;

      return [
        createUsageEvent({
          source: id,
          sessionId: path.basename(filePath, '.jsonl'),
          timestamp: '2026-02-01T00:00:00.000Z',
          inputTokens: 1,
          totalTokens,
        }),
      ];
    },
  };
}

function createAuxiliaryDependencyAdapter(
  id: string,
  files: string[],
  parseCallCounter: { count: number },
  getDependencyPath: (filePath: string) => string,
): SourceAdapter {
  return {
    id,
    discoverFiles: async () => files,
    getParseDependencies: async (filePath) => [getDependencyPath(filePath)],
    parseFile: async (filePath) => {
      parseCallCounter.count += 1;
      const dependencyPath = getDependencyPath(filePath);

      try {
        const content = await readFile(dependencyPath, 'utf8');
        const totalTokens =
          content
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0).length || 1;

        return [
          createUsageEvent({
            source: id,
            sessionId: path.basename(filePath),
            timestamp: '2026-02-01T00:00:00.000Z',
            inputTokens: 1,
            totalTokens,
          }),
        ];
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return [
            createUsageEvent({
              source: id,
              sessionId: path.basename(filePath),
              timestamp: '2026-02-01T00:00:00.000Z',
              inputTokens: 1,
              totalTokens: 1,
            }),
          ];
        }

        throw error;
      }
    },
  };
}

function createAdapterWithDiagnostics(
  id: SourceAdapter['id'],
  parseDiagnosticsByFile: Partial<Record<string, SourceParseFileDiagnostics>>,
): SourceAdapter {
  const files = Object.keys(parseDiagnosticsByFile);

  return {
    id,
    discoverFiles: async () => files,
    parseFile: async (filePath) => parseDiagnosticsByFile[filePath]?.events ?? [],
    parseFileWithDiagnostics: async (filePath) =>
      parseDiagnosticsByFile[filePath] ?? { events: [], skippedRows: 0 },
  };
}

async function writeFingerprintFixture(
  filePath: string,
  content: string,
  mtime: number,
): Promise<void> {
  await writeFile(filePath, content, 'utf8');
  await utimes(filePath, mtime, mtime);
}

function createInlineWorkerPool(status: 'ready' | 'fallback' = 'ready'): ParseWorkerPool {
  return {
    parse: async (_task, inlineParse) => inlineParse(),
    status: () => status,
    terminate: async () => undefined,
  };
}

describe('build-usage-data-parsing', () => {
  it('enforces one global parse concurrency budget across adapters', async () => {
    const stats = { current: 0, max: 0 };

    const result = await parseSelectedAdapters(
      [
        createDelayedAdapter('pi', '/tmp/pi-delayed.jsonl', stats),
        createDelayedAdapter('codex', '/tmp/codex-delayed.jsonl', stats),
      ],
      1,
    );

    expect(result.sourceFailures).toEqual([]);
    expect(result.successfulParseResults).toHaveLength(2);
    expect(stats.max).toBe(1);
  });

  it('stringifies non-Error parse failures without stopping healthy sources', async () => {
    const failingAdapter: SourceAdapter = {
      id: 'CoDex',
      discoverFiles: () => rejectWithUnknown('plain failure') as Promise<string[]>,
      parseFile: async () => [],
    };
    const succeedingAdapter: SourceAdapter = {
      id: 'codex',
      discoverFiles: async () => [],
      parseFile: async () => [],
    };

    const result = await parseSelectedAdapters([failingAdapter, succeedingAdapter], 1);

    expect(result.sourceFailures).toEqual([{ source: 'CoDex', reason: 'plain failure' }]);
    expect(result.successfulParseResults).toHaveLength(1);
  });

  it('keeps events from healthy files when a single file fails to parse', async () => {
    const adapter: SourceAdapter = {
      id: 'pi',
      discoverFiles: async () => ['/tmp/a.jsonl', '/tmp/b.jsonl', '/tmp/c.jsonl'],
      parseFile: async (filePath) => {
        if (filePath === '/tmp/b.jsonl') {
          throw new Error('file vanished mid-run');
        }

        return [
          createUsageEvent({
            source: 'pi',
            sessionId: path.basename(filePath, '.jsonl'),
            timestamp: '2026-02-01T00:00:00.000Z',
            inputTokens: 1,
            totalTokens: 1,
          }),
        ];
      },
    };

    const result = await parseSelectedAdapters([adapter], 1);

    expect(result.sourceFailures).toEqual([]);
    expect(result.successfulParseResults).toHaveLength(1);
    expect(result.successfulParseResults[0].events.map((event) => event.sessionId)).toEqual([
      'a',
      'c',
    ]);
    expect(result.successfulParseResults[0].skippedRows).toBe(1);
    expect(result.successfulParseResults[0].skippedRowReasons).toEqual([
      { reason: 'file_parse_failed', count: 1 },
    ]);
  });

  it('reports a source failure when every file fails to parse', async () => {
    const adapter: SourceAdapter = {
      id: 'pi',
      discoverFiles: async () => ['/tmp/a.jsonl', '/tmp/b.jsonl'],
      parseFile: async () => {
        throw new Error('permission denied');
      },
    };

    const result = await parseSelectedAdapters([adapter], 1);

    expect(result.successfulParseResults).toEqual([]);
    expect(result.sourceFailures).toEqual([
      {
        source: 'pi',
        reason: 'All 2 file(s) failed to parse for source pi: permission denied',
      },
    ]);
  });

  it('does not open the event store when the runtime flag is disabled', async () => {
    const openEventStore = vi.fn(
      async () => ({ filePath: '/tmp/events.db' }) as unknown as EventStore,
    );
    const adapter = createStoreBackedAdapter('pi', ['/tmp/pi-event-store-disabled.jsonl']);

    const result = await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: false,
        path: '/tmp/events.db',
        disabledBy: 'environment',
      },
      eventStoreDeps: {
        openEventStore,
      },
    });

    expect(openEventStore).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
    expect(result.successfulParseResults[0]?.events).toHaveLength(1);
  });

  it('writes parsed files to the event store and skips unchanged fingerprints', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-parse-writes-'));
    tempDirs.push(tempDir);

    const fileA = path.join(tempDir, 'a.jsonl');
    const fileB = path.join(tempDir, 'b.jsonl');
    await writeFingerprintFixture(fileA, '{"line":1}\n', 1_700_000_001);
    await writeFingerprintFixture(fileB, '{"line":1}\n', 1_700_000_001);

    const store = { filePath: path.join(tempDir, 'events.db') } as unknown as EventStore;
    const entries = new Map<string, EventStoreFileEntry>();
    const eventsByFile = new Map<string, ReturnType<typeof createUsageEvent>[]>();
    const openEventStore = vi.fn(async () => store);
    const closeEventStore = vi.fn();
    const getFileEntry = vi.fn((_store: EventStore, _source: string, filePath: string) =>
      entries.get(filePath),
    );
    const readFileEvents = vi.fn((_store: EventStore, _source: string, filePath: string) =>
      eventsByFile.get(filePath),
    );
    const replaceFileEvents = vi.fn((_store: EventStore, input: ReplaceFileEventsInput) => {
      entries.set(input.filePath, {
        fingerprint: serializeEventStoreFingerprint(input.fingerprint),
        skippedRows: input.skippedRows,
        skippedRowReasons: input.skippedRowReasons ?? [],
      });
      eventsByFile.set(input.filePath, input.events);
    });
    const adapter = createStoreBackedAdapter('pi', [fileA, fileB]);
    const options = {
      eventStore: {
        enabled: true as const,
        path: store.filePath,
      },
      eventStoreDeps: {
        openEventStore,
        closeEventStore,
        getFileEntry,
        readFileEvents,
        replaceFileEvents,
      },
      now: () => 123,
    };

    await parseSelectedAdapters([adapter], 1, options);
    await parseSelectedAdapters([adapter], 1, options);
    await writeFingerprintFixture(fileB, '{"line":1}\n{"line":2}\n', 1_700_000_002);
    await parseSelectedAdapters([adapter], 1, options);

    expect(openEventStore).toHaveBeenCalledTimes(3);
    expect(closeEventStore).toHaveBeenCalledTimes(3);
    expect(replaceFileEvents).toHaveBeenCalledTimes(3);
    expect(replaceFileEvents.mock.calls.map(([, input]) => input.filePath)).toEqual([
      fileA,
      fileB,
      fileB,
    ]);
  });

  it('keeps parsed output and returns one warning when the event store fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-parse-failure-'));
    tempDirs.push(tempDir);

    const fileA = path.join(tempDir, 'a.jsonl');
    const fileB = path.join(tempDir, 'b.jsonl');
    await writeFingerprintFixture(fileA, '{"line":1}\n', 1_700_000_001);
    await writeFingerprintFixture(fileB, '{"line":1}\n', 1_700_000_001);

    const store = { filePath: path.join(tempDir, 'events.db') } as unknown as EventStore;
    const replaceFileEvents = vi.fn();
    const result = await parseSelectedAdapters(
      [createStoreBackedAdapter('pi', [fileA, fileB])],
      1,
      {
        eventStore: {
          enabled: true,
          path: store.filePath,
        },
        eventStoreDeps: {
          openEventStore: async () => store,
          closeEventStore: vi.fn(),
          getFileEntry: () => {
            throw new Error('database locked');
          },
          replaceFileEvents,
        },
      },
    );

    expect(result.sourceFailures).toEqual([]);
    expect(result.successfulParseResults[0]?.events.map((event) => event.sessionId)).toEqual([
      'a',
      'b',
    ]);
    expect(result.warnings).toEqual(['Event store disabled after failure: database locked']);
    expect(replaceFileEvents).not.toHaveBeenCalled();
  });

  it('skips fingerprint work for remaining files after the store is disabled', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-disabled-gate-'));
    tempDirs.push(tempDir);

    const fileA = path.join(tempDir, 'a.jsonl');
    const fileB = path.join(tempDir, 'b.jsonl');
    await writeFingerprintFixture(fileA, '{"line":1}\n', 1_700_000_001);
    await writeFingerprintFixture(fileB, '{"line":1}\n', 1_700_000_001);

    const store = { filePath: path.join(tempDir, 'events.db') } as unknown as EventStore;
    const getParseDependencies = vi.fn(async () => []);
    const adapter: SourceAdapter = {
      ...createStoreBackedAdapter('pi', [fileA, fileB]),
      getParseDependencies,
    };

    const result = await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: store.filePath,
      },
      eventStoreDeps: {
        openEventStore: async () => store,
        closeEventStore: vi.fn(),
        getFileEntry: () => {
          throw new Error('database locked');
        },
        replaceFileEvents: vi.fn(),
      },
    });

    expect(result.warnings).toEqual(['Event store disabled after failure: database locked']);
    // File A trips the failure; file B must not be fingerprinted at all.
    expect(getParseDependencies).toHaveBeenCalledTimes(1);
    expect(getParseDependencies).toHaveBeenCalledWith(fileA);
  });

  it('serves unchanged files from the event store before adapter parsing', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-parse-hit-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'session.jsonl');
    const eventStorePath = path.join(tempDir, 'events.db');
    await writeFingerprintFixture(filePath, '{"line":1}\n', 1_700_000_001);

    const parseCalls = { count: 0 };
    const adapter = createCountingJsonlAdapter('pi', [filePath], parseCalls);

    await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
      now: () => 123,
    });

    const runtimeProfile = new RuntimeProfileCollector(() => 100);

    const cachedRun = await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
      runtimeProfile,
      now: () => 124,
    });

    expect(cachedRun.sourceFailures).toEqual([]);
    expect(cachedRun.successfulParseResults[0]?.events[0]?.totalTokens).toBe(1);
    expect(parseCalls.count).toBe(1);
    expect(runtimeProfile.snapshot().eventStore).toEqual({ hits: 1, misses: 0 });
  });

  it('re-parses and re-ingests when a primary file fingerprint changes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-primary-change-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'session.jsonl');
    const eventStorePath = path.join(tempDir, 'events.db');
    await writeFingerprintFixture(filePath, '{"line":1}\n', 1_700_000_001);

    const parseCalls = { count: 0 };
    const adapter = createCountingJsonlAdapter('pi', [filePath], parseCalls);

    const firstRun = await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
    });
    await writeFingerprintFixture(filePath, '{"line":1}\n{"line":2}\n', 1_700_000_002);
    const secondRun = await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
    });

    expect(firstRun.successfulParseResults[0]?.events[0]?.totalTokens).toBe(1);
    expect(secondRun.successfulParseResults[0]?.events[0]?.totalTokens).toBe(2);
    expect(parseCalls.count).toBe(2);
  });

  it('re-parses when an auxiliary dependency changes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-aux-change-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'session.jsonl');
    const dependencyPath = path.join(tempDir, 'session.jsonl-wal');
    const eventStorePath = path.join(tempDir, 'events.db');
    await writeFingerprintFixture(filePath, '{"primary":true}\n', 1_700_000_001);
    await writeFingerprintFixture(dependencyPath, 'line-1\n', 1_700_000_001);

    const parseCalls = { count: 0 };
    const adapter = createAuxiliaryDependencyAdapter(
      'opencode',
      [filePath],
      parseCalls,
      () => dependencyPath,
    );

    await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
    });
    const cachedRun = await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
    });
    await writeFingerprintFixture(dependencyPath, 'line-1\nline-2\n', 1_700_000_002);
    const invalidatedRun = await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
    });

    expect(cachedRun.successfulParseResults[0]?.events[0]?.totalTokens).toBe(1);
    expect(invalidatedRun.successfulParseResults[0]?.events[0]?.totalTokens).toBe(2);
    expect(parseCalls.count).toBe(2);
  });

  it('re-parses when an auxiliary dependency appears or disappears', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-aux-existence-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'session.jsonl');
    const dependencyPath = path.join(tempDir, 'sidecar.json');
    const eventStorePath = path.join(tempDir, 'events.db');
    await writeFingerprintFixture(filePath, '{"primary":true}\n', 1_700_000_001);

    const parseCalls = { count: 0 };
    const adapter = createAuxiliaryDependencyAdapter(
      'gemini',
      [filePath],
      parseCalls,
      () => dependencyPath,
    );

    const missingDependencyRun = await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
    });
    await writeFingerprintFixture(dependencyPath, 'line-1\nline-2\n', 1_700_000_002);
    const appearedDependencyRun = await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
    });
    await rm(dependencyPath);
    const disappearedDependencyRun = await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
    });

    expect(missingDependencyRun.successfulParseResults[0]?.events[0]?.totalTokens).toBe(1);
    expect(appearedDependencyRun.successfulParseResults[0]?.events[0]?.totalTokens).toBe(2);
    expect(disappearedDependencyRun.successfulParseResults[0]?.events[0]?.totalTokens).toBe(1);
    expect(parseCalls.count).toBe(3);
  });

  it('falls back to parsing and re-ingests when a stored event row is corrupted', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-corrupt-row-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'session.jsonl');
    const eventStorePath = path.join(tempDir, 'events.db');
    await writeFingerprintFixture(filePath, '{"line":1}\n', 1_700_000_001);

    const parseCalls = { count: 0 };
    const adapter = createCountingJsonlAdapter('codex', [filePath], parseCalls);

    await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
    });

    const store = await openEventStore(eventStorePath);
    try {
      store.database
        .prepare("UPDATE events SET cost_mode = 'broken' WHERE file_path = ?")
        .run(filePath);
    } finally {
      closeEventStore(store);
    }

    const secondRun = await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
    });

    expect(secondRun.sourceFailures).toEqual([]);
    expect(secondRun.warnings).toEqual([]);
    expect(secondRun.successfulParseResults[0]?.events[0]?.totalTokens).toBe(1);
    expect(parseCalls.count).toBe(2);
  });

  it('replays stored skipped-row diagnostics on an event store hit', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-diagnostics-replay-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'session.jsonl');
    const eventStorePath = path.join(tempDir, 'events.db');
    await writeFingerprintFixture(filePath, '{"line":1}\n', 1_700_000_001);

    let allowParse = true;
    let parseCalls = 0;
    const adapter: SourceAdapter = {
      id: 'pi',
      discoverFiles: async () => [filePath],
      parseFile: async () => {
        throw new Error('parseFile should not be used');
      },
      parseFileWithDiagnostics: async () => {
        if (!allowParse) {
          throw new Error('store hit should skip adapter parse');
        }

        parseCalls += 1;
        return {
          events: [
            createUsageEvent({
              source: 'pi',
              sessionId: 'session',
              timestamp: '2026-02-01T00:00:00.000Z',
              inputTokens: 1,
              totalTokens: 1,
            }),
          ],
          skippedRows: 2,
          skippedRowReasons: [{ reason: 'no_token_usage', count: 2 }],
        };
      },
    };

    await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
    });
    allowParse = false;
    const cachedRun = await parseSelectedAdapters([adapter], 1, {
      eventStore: {
        enabled: true,
        path: eventStorePath,
      },
    });

    expect(parseCalls).toBe(1);
    expect(cachedRun.sourceFailures).toEqual([]);
    expect(cachedRun.successfulParseResults[0]?.skippedRows).toBe(2);
    expect(cachedRun.successfulParseResults[0]?.skippedRowReasons).toEqual([
      { reason: 'no_token_usage', count: 2 },
    ]);
  });

  it('does not create a worker pool when codex misses are below the byte threshold', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'worker-threshold-inline-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'small.jsonl');
    await writeFile(filePath, '{"line":1}\n', 'utf8');

    const createPool = vi.fn(() => createInlineWorkerPool());
    const adapter = createAdapterWithDiagnostics('codex', {
      [filePath]: {
        events: [
          createUsageEvent({
            source: 'codex',
            sessionId: 'small',
            timestamp: '2026-02-01T00:00:00.000Z',
            totalTokens: 1,
          }),
        ],
        skippedRows: 0,
      },
    });

    const result = await parseAdapterEvents(adapter, 1, undefined, undefined, undefined, {
      workerCount: 2,
      minBytes: 1_000,
      createPool,
    });

    expect(createPool).not.toHaveBeenCalled();
    expect(result.events.map((event) => event.sessionId)).toEqual(['small']);
  });

  it('does not create a worker pool when parse workers are disabled', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'worker-disabled-inline-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'session.jsonl');
    await writeFile(filePath, '{"line":1}\n', 'utf8');

    const createPool = vi.fn(() => createInlineWorkerPool());
    const adapter = createAdapterWithDiagnostics('codex', {
      [filePath]: {
        events: [
          createUsageEvent({
            source: 'codex',
            sessionId: 'disabled',
            timestamp: '2026-02-01T00:00:00.000Z',
            totalTokens: 1,
          }),
        ],
        skippedRows: 0,
      },
    });

    const result = await parseAdapterEvents(adapter, 1, undefined, undefined, undefined, {
      workerCount: 0,
      minBytes: 0,
      createPool,
    });

    expect(createPool).not.toHaveBeenCalled();
    expect(result.events.map((event) => event.sessionId)).toEqual(['disabled']);
  });

  it('excludes event-store hits from the worker engagement byte threshold', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'worker-threshold-store-hit-'));
    tempDirs.push(tempDir);

    const fileA = path.join(tempDir, 'a.jsonl');
    const fileB = path.join(tempDir, 'b.jsonl');
    await writeFingerprintFixture(fileA, '{"a":1}\n', 1_700_000_001);
    await writeFingerprintFixture(fileB, '{"b":1}\n', 1_700_000_001);

    const store = { filePath: path.join(tempDir, 'events.db') } as unknown as EventStore;
    const entries = new Map<string, EventStoreFileEntry>();
    const eventsByFile = new Map<string, ReturnType<typeof createUsageEvent>[]>();
    const parseCalls = { count: 0 };
    const createPool = vi.fn(() => createInlineWorkerPool());
    const adapter = createCountingJsonlAdapter('codex', [fileA, fileB], parseCalls);
    const options = {
      eventStore: {
        enabled: true as const,
        path: store.filePath,
      },
      eventStoreDeps: {
        openEventStore: async () => store,
        closeEventStore: vi.fn(),
        getFileEntry: (_store: EventStore, _source: string, filePath: string) =>
          entries.get(filePath),
        readFileEvents: (_store: EventStore, _source: string, filePath: string) =>
          eventsByFile.get(filePath),
        replaceFileEvents: (_store: EventStore, input: ReplaceFileEventsInput) => {
          entries.set(input.filePath, {
            fingerprint: serializeEventStoreFingerprint(input.fingerprint),
            skippedRows: input.skippedRows,
            skippedRowReasons: input.skippedRowReasons ?? [],
          });
          eventsByFile.set(input.filePath, input.events);
        },
      },
      now: () => 123,
    };

    await parseSelectedAdapters([adapter], 1, {
      ...options,
      parseWorkers: {
        workerCount: 0,
        minBytes: 0,
        createPool,
      },
    });
    await writeFingerprintFixture(fileB, '{"b":1}\n{"b":2}\n', 1_700_000_002);
    await parseSelectedAdapters([adapter], 1, {
      ...options,
      parseWorkers: {
        workerCount: 2,
        minBytes: 20,
        createPool,
      },
    });

    expect(createPool).not.toHaveBeenCalled();
    expect(parseCalls.count).toBe(3);
  });

  it('keeps diagnostics identical between inline and worker-pool parsing', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'worker-diagnostics-parity-'));
    tempDirs.push(tempDir);

    const fileA = path.join(tempDir, 'a.jsonl');
    const fileB = path.join(tempDir, 'b.jsonl');
    const fileC = path.join(tempDir, 'c.jsonl');
    await writeFile(fileA, '{"line":1}\n', 'utf8');
    await writeFile(fileB, '{"line":2}\n', 'utf8');
    await writeFile(fileC, '{"line":3}\n', 'utf8');

    const dispatchedFiles: string[] = [];
    const completedFiles: string[] = [];
    const completionDelayByFile = new Map([
      [fileA, 30],
      [fileB, 15],
      [fileC, 0],
    ]);
    const pool: ParseWorkerPool = {
      parse: async (task, inlineParse) => {
        dispatchedFiles.push(task.filePath);
        await new Promise((resolve) => {
          setTimeout(resolve, completionDelayByFile.get(task.filePath));
        });
        const diagnostics = await inlineParse();
        completedFiles.push(task.filePath);
        return diagnostics;
      },
      status: () => 'ready',
      terminate: async () => undefined,
    };
    const createPool = vi.fn(() => pool);
    const adapter = createAdapterWithDiagnostics('codex', {
      [fileA]: {
        events: [
          createUsageEvent({
            source: 'codex',
            sessionId: 'a',
            timestamp: '2026-02-01T00:00:00.000Z',
            totalTokens: 1,
          }),
        ],
        skippedRows: 1,
        skippedRowReasons: [{ reason: 'no_usage', count: 1 }],
      },
      [fileB]: {
        events: [
          createUsageEvent({
            source: 'codex',
            sessionId: 'b',
            timestamp: '2026-02-01T00:00:00.000Z',
            totalTokens: 1,
          }),
        ],
        skippedRows: 2,
        skippedRowReasons: [{ reason: 'invalid_timestamp', count: 2 }],
      },
      [fileC]: {
        events: [
          createUsageEvent({
            source: 'codex',
            sessionId: 'c',
            timestamp: '2026-02-01T00:00:00.000Z',
            totalTokens: 1,
          }),
        ],
        skippedRows: 3,
        skippedRowReasons: [{ reason: 'no_usage', count: 3 }],
      },
    });

    const inlineResult = await parseAdapterEvents(adapter, 3, undefined, undefined, undefined, {
      workerCount: 0,
      minBytes: 0,
    });
    const workerResult = await parseAdapterEvents(adapter, 3, undefined, undefined, undefined, {
      workerCount: 3,
      minBytes: 1,
      createPool,
    });

    expect(createPool).toHaveBeenCalledTimes(1);
    expect(dispatchedFiles).toEqual([fileA, fileB, fileC]);
    expect(completedFiles).toEqual([fileC, fileB, fileA]);
    expect(workerResult.events.map((event) => event.sessionId)).toEqual(['a', 'b', 'c']);
    expect(workerResult).toEqual(inlineResult);
  });
});
