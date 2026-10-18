import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseAdapterEvents,
  parseSelectedAdapters,
} from '../../src/cli/build-usage-data-parsing.js';
import {
  createParseWorkerPool,
  type ParseWorkerLike,
  type ParseWorkerPool,
} from '../../src/cli/parse-worker-pool.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  openEventStore,
  readFileEvents as readStoredFileEvents,
  serializeEventStoreFingerprint,
  type EventStore,
  type EventStoreFileEntry,
  type ReplaceFileEventsInput,
} from '../../src/persistence/event-store.js';
import {
  createToolCallEvent,
  createUsageRecord,
  type SourceAdapter,
  type SourceParseFileDiagnostics,
} from '@ayagmar/agent-sessions';
import { RuntimeProfileCollector } from '../../src/cli/runtime-profile.js';
import { readFrom, readWithDiagnostics } from '../helpers/fake-read.js';

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
    read: readFrom(async () => {
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
    }),
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
    read: readFrom(async (filePath) => [
      createUsageEvent({
        source: id,
        sessionId: path.basename(filePath, '.jsonl'),
        timestamp: '2026-02-01T00:00:00.000Z',
        inputTokens: 1,
        totalTokens: 1,
      }),
    ]),
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
    read: readFrom(async (filePath) => {
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
    }),
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
    read: readFrom(async (filePath) => {
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
    }),
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
    read: readWithDiagnostics(
      async (filePath) => parseDiagnosticsByFile[filePath] ?? { events: [], skippedRows: 0 },
    ),
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

/** A worker that declines every task, so the pool reruns it inline. */
function createDecliningWorker(): ParseWorkerLike {
  let onMessage: ((message: unknown) => void) | undefined;
  const worker: ParseWorkerLike = {
    postMessage: (message) => {
      setTimeout(() => onMessage?.({ taskId: message.taskId, ok: false, error: 'declined' }), 1);
    },
    terminate: async () => 0,
    on: (event, listener) => {
      if (event === 'message') {
        onMessage = listener;
      }

      return worker;
    },
  };

  return worker;
}

function createWorkerSourceAdapters(sourceIds: readonly string[], filesPerSource: number) {
  return sourceIds.map((sourceId) =>
    createAdapterWithDiagnostics(
      sourceId,
      Object.fromEntries(
        Array.from({ length: filesPerSource }, (_, index) => [
          `/data/${sourceId}/${index}.jsonl`,
          {
            events: [
              createUsageEvent({
                source: sourceId,
                sessionId: `${sourceId}-${index}`,
                timestamp: '2026-02-01T00:00:00.000Z',
                totalTokens: 1,
              }),
            ],
            skippedRows: 0,
          },
        ]),
      ),
    ),
  );
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
      discoverFiles: () => rejectWithUnknown('plain failure'),
      read: readFrom(async () => []),
    };
    const succeedingAdapter: SourceAdapter = {
      id: 'codex',
      discoverFiles: async () => [],
      read: readFrom(async () => []),
    };

    const result = await parseSelectedAdapters([failingAdapter, succeedingAdapter], 1);

    expect(result.sourceFailures).toEqual([{ source: 'CoDex', reason: 'plain failure' }]);
    expect(result.successfulParseResults).toHaveLength(1);
  });

  it('keeps events from healthy files when a single file fails to parse', async () => {
    const adapter: SourceAdapter = {
      id: 'pi',
      discoverFiles: async () => ['/tmp/a.jsonl', '/tmp/b.jsonl', '/tmp/c.jsonl'],
      read: readFrom(async (filePath) => {
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
      }),
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

  it.each([
    { eventsRepeatAcrossFiles: true, expected: ['shared', 'shared', 'a-only', 'b-only'] },
    {
      eventsRepeatAcrossFiles: false,
      expected: ['shared', 'shared', 'a-only', 'shared', 'b-only'],
    },
  ])(
    'counts an event repeated across files once only when the source repeats events across files ($eventsRepeatAcrossFiles)',
    async ({ eventsRepeatAcrossFiles, expected }) => {
      const event = (sessionId: string) =>
        createUsageEvent({
          source: 'pi',
          sessionId,
          timestamp: '2026-02-01T00:00:00.000Z',
          inputTokens: 1,
          totalTokens: 1,
        });
      // A repeat within one file is kept: only a copy in another file is the same event.
      const adapter: SourceAdapter = {
        ...createAdapterWithDiagnostics('pi', {
          '/tmp/a.jsonl': {
            events: [event('shared'), event('shared'), event('a-only')],
            skippedRows: 0,
          },
          '/tmp/b.jsonl': { events: [event('shared'), event('b-only')], skippedRows: 0 },
        }),
        capabilities: { eventsRepeatAcrossFiles },
      };

      const result = await parseSelectedAdapters([adapter], 1);

      expect(result.successfulParseResults[0].events.map((parsed) => parsed.sessionId)).toEqual(
        expected,
      );
    },
  );

  it('gives adapter events the cost mode their cost implies and keeps one already set', async () => {
    const adapterEvent = (sessionId: string, costUsd?: number) => ({
      source: 'pi',
      sessionId,
      timestamp: '2026-02-01T00:00:00.000Z',
      inputTokens: 1,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      totalTokens: 1,
      costUsd,
    });
    const storedMode = { ...adapterEvent('stored', 0.5), costMode: 'estimated' as const };
    const adapter: SourceAdapter = {
      id: 'pi',
      discoverFiles: async () => ['/tmp/a.jsonl'],
      read: readFrom(async () => [
        adapterEvent('unpriced'),
        adapterEvent('logged', 0.25),
        storedMode,
      ]),
    };

    const result = await parseSelectedAdapters([adapter], 1);
    const events = result.successfulParseResults[0].events;

    expect(events.map((event) => [event.sessionId, event.costUsd, event.costMode])).toEqual([
      ['unpriced', undefined, 'estimated'],
      ['logged', 0.25, 'explicit'],
      ['stored', 0.5, 'estimated'],
    ]);
    // Event JSON feeds the events output and machine-export revisions.
    expect(events.map((event) => Object.keys(event).slice(-2))).toEqual([
      ['costUsd', 'costMode'],
      ['costUsd', 'costMode'],
      ['costUsd', 'costMode'],
    ]);
  });

  it('reports a source failure when every file fails to parse', async () => {
    const adapter: SourceAdapter = {
      id: 'pi',
      discoverFiles: async () => ['/tmp/a.jsonl', '/tmp/b.jsonl'],
      read: readFrom(async () => {
        throw new Error('permission denied');
      }),
    };

    const result = await parseSelectedAdapters([adapter], 1);

    expect(result.successfulParseResults).toEqual([]);
    expect(result.sourceFailures).toEqual([
      {
        source: 'pi',
        reason: 'All 2 files failed to parse for source pi: permission denied',
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
    const replaceFilesEvents = vi.fn(
      (_store: EventStore, inputs: readonly ReplaceFileEventsInput[]) => {
        for (const input of inputs) {
          entries.set(input.filePath, {
            fingerprint: serializeEventStoreFingerprint(input.fingerprint),
            skippedRows: input.skippedRows,
            skippedRowReasons: input.skippedRowReasons ?? [],
          });
          eventsByFile.set(input.filePath, input.events);
        }
      },
    );
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
        replaceFilesEvents,
      },
      now: () => 123,
    };

    await parseSelectedAdapters([adapter], 1, options);
    await parseSelectedAdapters([adapter], 1, options);
    await writeFingerprintFixture(fileB, '{"line":1}\n{"line":2}\n', 1_700_000_002);
    await parseSelectedAdapters([adapter], 1, options);

    expect(openEventStore).toHaveBeenCalledTimes(3);
    expect(closeEventStore).toHaveBeenCalledTimes(3);
    // One batched write per run that had misses: both files, then only the changed one.
    expect(replaceFilesEvents).toHaveBeenCalledTimes(2);
    expect(
      replaceFilesEvents.mock.calls.map(([, inputs]) => inputs.map((input) => input.filePath)),
    ).toEqual([[fileA, fileB], [fileB]]);
  });

  it('flushes parse misses to the event store in bounded batches', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-write-batches-'));
    tempDirs.push(tempDir);

    const files = ['a', 'b', 'c'].map((name) => path.join(tempDir, `${name}.jsonl`));

    for (const filePath of files) {
      await writeFingerprintFixture(filePath, '{}\n', 1_700_000_001);
    }

    const adapter: SourceAdapter = {
      id: 'pi',
      discoverFiles: async () => files,
      read: readFrom(async (filePath) =>
        Array.from({ length: 3_000 }, (_, index) =>
          createUsageEvent({
            source: 'pi',
            sessionId: path.basename(filePath, '.jsonl'),
            timestamp: new Date(Date.UTC(2026, 1, 1) + index * 1_000).toISOString(),
            inputTokens: 1,
            totalTokens: 1,
          }),
        ),
      ),
    };
    const batches: string[][] = [];
    const replaceFilesEvents = vi.fn(
      (_store: EventStore, inputs: readonly ReplaceFileEventsInput[]) => {
        batches.push(inputs.map((input) => path.basename(input.filePath)));
      },
    );

    await parseSelectedAdapters([adapter], 1, {
      eventStore: { enabled: true, path: path.join(tempDir, 'events.db') },
      eventStoreDeps: {
        openEventStore: async () => ({}) as EventStore,
        closeEventStore: vi.fn(),
        getFileEntry: () => undefined,
        replaceFilesEvents,
      },
    });

    // 5,000 events per batch: a + b cross the bound, c is flushed at the end.
    expect(batches).toEqual([['a.jsonl', 'b.jsonl'], ['c.jsonl']]);
  });

  it('stores tool calls with their file and counts them toward the write batch', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-tool-call-batches-'));
    tempDirs.push(tempDir);

    const files = ['a', 'b', 'c'].map((name) => path.join(tempDir, `${name}.jsonl`));

    for (const filePath of files) {
      await writeFingerprintFixture(filePath, '{}\n', 1_700_000_001);
    }

    // One request and 3,000 tool calls per file.
    const adapter: SourceAdapter = {
      id: 'pi',
      capabilities: { kinds: ['usage', 'tool_call'] },
      discoverFiles: async () => files,
      read: readFrom(async () => []),
      readEvents: async function* (filePath) {
        const sessionId = path.basename(filePath, '.jsonl');
        const timestamp = '2026-02-01T00:00:00.000Z';
        yield createUsageRecord({ source: 'pi', sessionId, timestamp, inputTokens: 1 });

        for (let index = 0; index < 3_000; index += 1) {
          yield createToolCallEvent({
            source: 'pi',
            sessionId,
            timestamp,
            name: 'bash',
            status: 'ok',
          });
        }
      },
    };
    const batches: [file: string, usage: number, toolCalls: number][][] = [];
    const replaceFilesEvents = vi.fn(
      (_store: EventStore, inputs: readonly ReplaceFileEventsInput[]) => {
        batches.push(
          inputs.map((input) => [
            path.basename(input.filePath),
            input.events.length,
            input.sessionEvents?.length ?? 0,
          ]),
        );
      },
    );

    await parseSelectedAdapters([adapter], 1, {
      eventStore: { enabled: true, path: path.join(tempDir, 'events.db') },
      eventStoreDeps: {
        openEventStore: async () => ({}) as EventStore,
        closeEventStore: vi.fn(),
        getFileEntry: () => undefined,
        replaceFilesEvents,
      },
    });

    expect(batches).toEqual([
      [
        ['a.jsonl', 1, 3_000],
        ['b.jsonl', 1, 3_000],
      ],
      [['c.jsonl', 1, 3_000]],
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
    const replaceFilesEvents = vi.fn();
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
          replaceFilesEvents,
        },
      },
    );

    expect(result.sourceFailures).toEqual([]);
    expect(result.successfulParseResults[0]?.events.map((event) => event.sessionId)).toEqual([
      'a',
      'b',
    ]);
    expect(result.warnings).toEqual(['Event store disabled after failure: database locked']);
    expect(replaceFilesEvents).not.toHaveBeenCalled();
  });

  it('keeps the event store when recording usual-location files fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-claim-failure-'));
    tempDirs.push(tempDir);

    const fileA = path.join(tempDir, 'a.jsonl');
    await writeFingerprintFixture(fileA, '{"line":1}\n', 1_700_000_001);

    const store = await openEventStore(path.join(tempDir, 'events.db'));
    const result = await parseSelectedAdapters([createStoreBackedAdapter('pi', [fileA])], 1, {
      eventStore: { enabled: true, path: store.filePath },
      openedStore: store,
      eventStoreDeps: {
        claimOverrideOnlyFiles: () => {
          throw new Error('database is locked');
        },
      },
    });
    closeEventStore(store);

    expect(result.eventStoreAvailable).toBe(true);
    expect(result.warnings).toEqual([
      'Event store could not record files found in their usual location: database is locked',
    ]);
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
        replaceFilesEvents: vi.fn(),
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

  it('re-parses unchanged files when the adapter parser version changes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'event-store-parser-version-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'session.jsonl');
    const eventStorePath = path.join(tempDir, 'events.db');
    await writeFingerprintFixture(filePath, '{"line":1}\n', 1_700_000_001);

    const parseCalls = { count: 0 };
    const adapter = createCountingJsonlAdapter('pi', [filePath], parseCalls);
    const eventStoreOptions = { eventStore: { enabled: true as const, path: eventStorePath } };

    await parseSelectedAdapters([adapter], 1, eventStoreOptions);
    await parseSelectedAdapters([adapter], 1, eventStoreOptions);
    expect(parseCalls.count).toBe(1);

    const runtimeProfile = new RuntimeProfileCollector(() => 100);
    await parseSelectedAdapters([{ ...adapter, parserVersion: 2 }], 1, {
      ...eventStoreOptions,
      runtimeProfile,
    });
    await parseSelectedAdapters([{ ...adapter, parserVersion: 2 }], 1, eventStoreOptions);

    expect(parseCalls.count).toBe(2);
    expect(runtimeProfile.snapshot().eventStore).toEqual({ hits: 0, misses: 1 });
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

  // A real SQLite store: slow on Windows CI runners.
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
  }, 20_000);

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
      read: readWithDiagnostics(async () => {
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
      }),
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
        replaceFilesEvents: (_store: EventStore, inputs: readonly ReplaceFileEventsInput[]) => {
          for (const input of inputs) {
            entries.set(input.filePath, {
              fingerprint: serializeEventStoreFingerprint(input.fingerprint),
              skippedRows: input.skippedRows,
              skippedRowReasons: input.skippedRowReasons ?? [],
            });
            eventsByFile.set(input.filePath, input.events);
          }
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

  it('shares one parse pool, bounded by the worker count, across every worker source', async () => {
    const spawnWorker = vi.fn(createDecliningWorker);
    let terminateCalls = 0;
    const createPool = vi.fn((options: Parameters<typeof createParseWorkerPool>[0]) => {
      const pool = createParseWorkerPool({ ...options, spawnWorker });
      return {
        ...pool,
        terminate: async () => {
          terminateCalls += 1;
          await pool.terminate();
        },
      };
    });
    const runtimeProfile = new RuntimeProfileCollector(() => 0);
    const sourceIds = ['claude', 'pi', 'codex'];

    const result = await parseSelectedAdapters(createWorkerSourceAdapters(sourceIds, 4), 8, {
      parseWorkers: { workerCount: 3, minBytes: 0, createPool },
      runtimeProfile,
    });

    expect(createPool).toHaveBeenCalledTimes(1);
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({ workerCount: 3 }));
    expect(spawnWorker).toHaveBeenCalledTimes(3);
    expect(terminateCalls).toBe(1);
    expect(result.sourceFailures).toEqual([]);
    expect(
      result.successfulParseResults.map((parseResult) =>
        parseResult.events.map((event) => event.sessionId),
      ),
    ).toEqual(sourceIds.map((sourceId) => [0, 1, 2, 3].map((index) => `${sourceId}-${index}`)));
    expect(
      runtimeProfile.snapshot().sourceStats.map((stats) => [stats.source, stats.parseWorkers]),
    ).toEqual([
      ['claude', 'engaged'],
      ['codex', 'engaged'],
      ['pi', 'engaged'],
    ]);
  });

  it('creates no parse pool when no source sends it work', async () => {
    const createPool = vi.fn(() => createInlineWorkerPool());

    await parseSelectedAdapters(createWorkerSourceAdapters(['claude', 'pi'], 2), 4, {
      parseWorkers: { workerCount: 3, minBytes: Number.MAX_SAFE_INTEGER, createPool },
    });

    expect(createPool).not.toHaveBeenCalled();
  });

  it('terminates the shared parse pool when a source fails', async () => {
    const terminate = vi.fn(async () => undefined);
    const createPool = vi.fn(() => ({ ...createInlineWorkerPool(), terminate }));
    const failingAdapter: SourceAdapter = {
      id: 'claude',
      discoverFiles: async () => ['/data/claude/broken.jsonl'],
      read: readWithDiagnostics(async () => {
        throw new Error('broken file');
      }),
    };

    const result = await parseSelectedAdapters(
      [failingAdapter, ...createWorkerSourceAdapters(['pi'], 2)],
      4,
      { parseWorkers: { workerCount: 2, minBytes: 0, createPool } },
    );

    expect(result.sourceFailures.map((failure) => failure.source)).toEqual(['claude']);
    expect(createPool).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('dispatches largest misses first while preserving inline output order', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'worker-diagnostics-parity-'));
    tempDirs.push(tempDir);

    const fileA = path.join(tempDir, 'a.jsonl');
    const fileB = path.join(tempDir, 'b.jsonl');
    const fileC = path.join(tempDir, 'c.jsonl');
    const fileD = path.join(tempDir, 'd.jsonl');
    await writeFile(fileA, 'a'.repeat(10), 'utf8');
    await writeFile(fileB, 'b'.repeat(40), 'utf8');
    await writeFile(fileC, 'c'.repeat(20), 'utf8');
    await writeFile(fileD, 'd'.repeat(20), 'utf8');

    const dispatchedFiles: string[] = [];
    const completedFiles: string[] = [];
    const completionDelayByFile = new Map([
      [fileA, 0],
      [fileB, 30],
      [fileC, 20],
      [fileD, 10],
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
      [fileD]: {
        events: [
          createUsageEvent({
            source: 'codex',
            sessionId: 'd',
            timestamp: '2026-02-01T00:00:00.000Z',
            totalTokens: 1,
          }),
        ],
        skippedRows: 4,
        skippedRowReasons: [{ reason: 'invalid_timestamp', count: 4 }],
      },
    });

    const inlineResult = await parseAdapterEvents(adapter, 4, undefined, undefined, undefined, {
      workerCount: 0,
      minBytes: 0,
    });
    const workerResult = await parseAdapterEvents(adapter, 4, undefined, undefined, undefined, {
      workerCount: 4,
      minBytes: 1,
      createPool,
    });

    expect(createPool).toHaveBeenCalledTimes(1);
    expect(dispatchedFiles).toEqual([fileB, fileC, fileD, fileA]);
    expect(completedFiles).toEqual([fileA, fileD, fileC, fileB]);
    expect(workerResult.events.map((event) => event.sessionId)).toEqual(['a', 'b', 'c', 'd']);
    expect(workerResult).toEqual(inlineResult);
  });

  describe('--since file skipping', () => {
    const since = '2026-02-10';
    // One day of timezone slack before the window: 2026-02-09T00:00:00Z.
    const beforeCutoffSeconds = Date.parse('2026-02-08T23:00:00.000Z') / 1000;
    const afterCutoffSeconds = Date.parse('2026-02-09T01:00:00.000Z') / 1000;

    function withMtimeSkip(adapter: SourceAdapter): SourceAdapter {
      return { ...adapter, capabilities: { eventsPrecedeFileMtime: true } };
    }

    async function createSessionFiles(
      prefix: string,
      mtimes: Record<string, number>,
    ): Promise<{ tempDir: string; files: Record<string, string> }> {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
      tempDirs.push(tempDir);
      const files: Record<string, string> = {};

      for (const [name, mtime] of Object.entries(mtimes)) {
        files[name] = path.join(tempDir, `${name}.jsonl`);
        await writeFingerprintFixture(files[name], '{"line":1}\n', mtime);
      }

      return { tempDir, files };
    }

    it('skips files last modified before the window but still reports them as discovered', async () => {
      const { files } = await createSessionFiles('since-skip-no-store-', {
        old: beforeCutoffSeconds,
        recent: afterCutoffSeconds,
      });
      const parseCalls = { count: 0 };
      const adapter = withMtimeSkip(
        createCountingJsonlAdapter('pi', [files.old, files.recent], parseCalls),
      );

      const result = await parseSelectedAdapters([adapter], 1, { since });

      expect(parseCalls.count).toBe(1);
      expect(result.successfulParseResults[0]?.events.map((event) => event.sessionId)).toEqual([
        'recent',
      ]);
      expect(result.successfulParseResults[0]?.filesFound).toBe(2);
      expect(result.discoveredFiles).toEqual([
        { source: 'pi', filePath: files.old },
        { source: 'pi', filePath: files.recent },
      ]);
    });

    it('parses every file without --since or without the adapter capability', async () => {
      const { files } = await createSessionFiles('since-skip-off-', { old: beforeCutoffSeconds });
      const parseCalls = { count: 0 };
      const adapter = createCountingJsonlAdapter('pi', [files.old], parseCalls);

      const withoutSince = await parseSelectedAdapters([withMtimeSkip(adapter)], 1, {});
      const withoutCapability = await parseSelectedAdapters([adapter], 1, { since });

      expect(parseCalls.count).toBe(2);
      for (const result of [withoutSince, withoutCapability]) {
        expect(result.parsedFiles).toEqual([{ source: 'pi', filePath: files.old }]);
      }
    });

    it('parses an old file whose parse dependency changed inside the window', async () => {
      const { tempDir, files } = await createSessionFiles('since-skip-dependency-', {
        old: beforeCutoffSeconds,
      });
      const dependencyPath = path.join(tempDir, 'sidecar.jsonl');
      await writeFingerprintFixture(dependencyPath, '{"line":1}\n', afterCutoffSeconds);
      const parseCalls = { count: 0 };
      const adapter = withMtimeSkip(
        createAuxiliaryDependencyAdapter('pi', [files.old], parseCalls, () => dependencyPath),
      );

      await parseSelectedAdapters([adapter], 1, { since });

      expect(parseCalls.count).toBe(1);
    });

    it('ingests an old file the store lacks, then skips it once stored', async () => {
      const { tempDir, files } = await createSessionFiles('since-skip-store-', {
        old: beforeCutoffSeconds,
      });
      const parseCalls = { count: 0 };
      const adapter = withMtimeSkip(createCountingJsonlAdapter('pi', [files.old], parseCalls));
      const eventStorePath = path.join(tempDir, 'events.db');
      const options = { since, eventStore: { enabled: true as const, path: eventStorePath } };

      const ingestRun = await parseSelectedAdapters([adapter], 1, options);
      expect(parseCalls.count).toBe(1);
      // Counted for the ledger, but marked so live reads leave it out.
      expect(ingestRun.parsedFiles).toEqual([
        { source: 'pi', filePath: files.old, beforeWindow: true },
      ]);

      const readFileEvents = vi.fn();
      const skippedRun = await parseSelectedAdapters([adapter], 1, {
        ...options,
        eventStoreDeps: { readFileEvents },
      });

      expect(parseCalls.count).toBe(1);
      expect(readFileEvents).not.toHaveBeenCalled();
      expect(skippedRun.successfulParseResults[0]?.events).toEqual([]);

      const store = await openEventStore(eventStorePath);

      try {
        expect(readStoredFileEvents(store, 'pi', files.old)).toHaveLength(1);
      } finally {
        closeEventStore(store);
      }
    });

    it('re-parses an old file whose stored copy is stale', async () => {
      const { tempDir, files } = await createSessionFiles('since-skip-stale-', {
        old: beforeCutoffSeconds,
      });
      const parseCalls = { count: 0 };
      const adapter = withMtimeSkip(createCountingJsonlAdapter('pi', [files.old], parseCalls));
      const eventStore = { enabled: true as const, path: path.join(tempDir, 'events.db') };

      await parseSelectedAdapters([adapter], 1, { eventStore });
      await writeFingerprintFixture(
        files.old,
        '{"line":1}\n{"line":2}\n',
        beforeCutoffSeconds + 60,
      );
      await parseSelectedAdapters([adapter], 1, { since, eventStore });
      await parseSelectedAdapters([adapter], 1, { since, eventStore });

      expect(parseCalls.count).toBe(2);
    });

    it('skips old files on the parse-worker path too', async () => {
      const { files } = await createSessionFiles('since-skip-workers-', {
        old: beforeCutoffSeconds,
        recent: afterCutoffSeconds,
      });
      const parseCalls = { count: 0 };
      const adapter = withMtimeSkip(
        createCountingJsonlAdapter('codex', [files.old, files.recent], parseCalls),
      );
      const createPool = vi.fn(() => createInlineWorkerPool());

      const result = await parseAdapterEvents(
        adapter,
        2,
        undefined,
        undefined,
        undefined,
        { workerCount: 2, minBytes: 0, createPool },
        since,
      );

      expect(createPool).toHaveBeenCalledTimes(1);
      expect(parseCalls.count).toBe(1);
      expect(result.events.map((event) => event.sessionId)).toEqual(['recent']);
      expect(result.filePaths).toEqual([files.old, files.recent]);
    });
  });
});
