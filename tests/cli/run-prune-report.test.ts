import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUsageEventDataset } from '../../src/cli/build-usage-event-dataset.js';
import {
  buildPruneReport,
  renderPruneReport,
  runPruneReport,
  type PruneReportResult,
} from '../../src/cli/run-prune-report.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  countEvents,
  openEventStore,
  readFileEvents,
  replaceFileEvents,
  type EventStore,
  type EventStoreFileFingerprint,
} from '../../src/persistence/event-store.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

async function createTempDbPath(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return path.join(tempDir, 'events.db');
}

function createEvent(overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {}) {
  return createUsageEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp: '2026-02-14T10:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 15,
    costMode: 'estimated',
    ...overrides,
  });
}

function createFingerprint(filePath: string): EventStoreFileFingerprint {
  return {
    dependencies: [{ path: filePath, exists: true, size: 10, mtimeMs: 20 }],
  };
}

function writeStoredFile(
  store: EventStore,
  options: {
    source?: string;
    filePath: string;
    events: UsageEvent[];
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

function createAdapter(options: {
  id?: SourceAdapter['id'];
  files: string[];
  eventsByFile?: ReadonlyMap<string, UsageEvent[]>;
  discoverError?: Error;
}): SourceAdapter {
  return {
    id: options.id ?? 'codex',
    async discoverFiles() {
      if (options.discoverError) {
        throw options.discoverError;
      }

      return options.files;
    },
    async parseFile(filePath) {
      return options.eventsByFile?.get(filePath) ?? [];
    },
  };
}

function createDeps(dbPath: string, adapters: SourceAdapter[]) {
  return {
    createAdapters: () => adapters,
    getEventStoreRuntimeConfig: () => ({
      enabled: true as const,
      path: dbPath,
    }),
  };
}

function captureStdout(): {
  getOutput: () => string;
  restore: () => void;
} {
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(`${args.join(' ')}\n`);
  });

  return {
    getOutput: () => chunks.join(''),
    restore: () => {
      logSpy.mockRestore();
    },
  };
}

describe('run-prune-report', () => {
  it('keeps the temp database byte-unchanged during a dry run', async () => {
    const dbPath = await createTempDbPath('prune-dry-run-');
    const oldPath = '/tmp/old.jsonl';
    const livePath = '/tmp/live.jsonl';
    const oldEvent = createEvent({ sessionId: 'moved-session' });
    const liveEvent = createEvent({ sessionId: 'moved-session' });
    const store = await openEventStore(dbPath);

    try {
      writeStoredFile(store, { filePath: oldPath, events: [oldEvent], now: 1_000 });
      writeStoredFile(store, { filePath: livePath, events: [liveEvent], now: 2_000 });
    } finally {
      closeEventStore(store);
    }

    const sizeBefore = (await stat(dbPath)).size;
    const result = await buildPruneReport(
      { suppressed: true },
      createDeps(dbPath, [createAdapter({ files: [livePath] })]),
    );
    const sizeAfter = (await stat(dbPath)).size;

    expect(result.summary).toMatchObject({
      applied: false,
      candidateFileCount: 1,
      candidateEventCount: 1,
    });
    expect(result.candidates).toEqual([
      {
        source: 'codex',
        filePath: oldPath,
        eventCount: 1,
        newestTimestamp: '2026-02-14T10:00:00.000Z',
        reasons: ['suppressed'],
      },
    ]);
    expect(sizeAfter).toBe(sizeBefore);
  });

  it('applies --suppressed by deleting only suppressed departed files', async () => {
    const dbPath = await createTempDbPath('prune-apply-suppressed-');
    const oldPath = '/tmp/old.jsonl';
    const livePath = '/tmp/live.jsonl';
    const uniquePath = '/tmp/unique.jsonl';
    const store = await openEventStore(dbPath);

    try {
      writeStoredFile(store, {
        filePath: oldPath,
        events: [createEvent({ sessionId: 'moved-session' })],
        now: 1_000,
      });
      writeStoredFile(store, {
        filePath: livePath,
        events: [createEvent({ sessionId: 'moved-session' })],
        now: 2_000,
      });
      writeStoredFile(store, {
        filePath: uniquePath,
        events: [createEvent({ sessionId: 'unique', inputTokens: 99, totalTokens: 104 })],
        now: 3_000,
      });
    } finally {
      closeEventStore(store);
    }

    const result = await buildPruneReport(
      { suppressed: true, apply: true },
      createDeps(dbPath, [createAdapter({ files: [livePath] })]),
    );
    const afterStore = await openEventStore(dbPath);

    try {
      expect(result.summary).toMatchObject({
        applied: true,
        candidateFileCount: 1,
        candidateEventCount: 1,
        deletedFileCount: 1,
        deletedEventCount: 1,
      });
      expect(readFileEvents(afterStore, 'codex', oldPath)).toEqual([]);
      expect(readFileEvents(afterStore, 'codex', livePath)).toHaveLength(1);
      expect(readFileEvents(afterStore, 'codex', uniquePath)).toHaveLength(1);
      expect(countEvents(afterStore)).toBe(2);
    } finally {
      closeEventStore(afterStore);
    }
  });

  it('keeps files whose newest timestamp is exactly on the departed-before UTC date', async () => {
    const dbPath = await createTempDbPath('prune-departed-before-');
    const oldPath = '/tmp/old.jsonl';
    const boundaryPath = '/tmp/boundary.jsonl';
    const store = await openEventStore(dbPath);

    try {
      writeStoredFile(store, {
        filePath: oldPath,
        events: [
          createEvent({
            sessionId: 'old',
            timestamp: '2025-12-31T23:59:59.000Z',
          }),
        ],
        now: 1_000,
      });
      writeStoredFile(store, {
        filePath: boundaryPath,
        events: [
          createEvent({
            sessionId: 'boundary',
            timestamp: '2026-01-01T00:00:00.000Z',
          }),
        ],
        now: 2_000,
      });
    } finally {
      closeEventStore(store);
    }

    const result = await buildPruneReport(
      { departedBefore: '2026-01-01' },
      createDeps(dbPath, [createAdapter({ files: [] })]),
    );

    expect(result.candidates.map((candidate) => candidate.filePath)).toEqual([oldPath]);
    expect(result.candidates[0]?.reasons).toEqual(['aged']);
  });

  it('combines suppressed and departed-before selectors as a union', async () => {
    const dbPath = await createTempDbPath('prune-selector-union-');
    const oldPath = '/tmp/old.jsonl';
    const livePath = '/tmp/live.jsonl';
    const agedPath = '/tmp/aged.jsonl';
    const store = await openEventStore(dbPath);

    try {
      writeStoredFile(store, {
        filePath: oldPath,
        events: [createEvent({ sessionId: 'moved-session' })],
        now: 1_000,
      });
      writeStoredFile(store, {
        filePath: livePath,
        events: [createEvent({ sessionId: 'moved-session' })],
        now: 2_000,
      });
      writeStoredFile(store, {
        filePath: agedPath,
        events: [
          createEvent({
            sessionId: 'aged',
            timestamp: '2025-12-31T23:00:00.000Z',
            inputTokens: 42,
            totalTokens: 47,
          }),
        ],
        now: 3_000,
      });
    } finally {
      closeEventStore(store);
    }

    const result = await buildPruneReport(
      { suppressed: true, departedBefore: '2026-01-01' },
      createDeps(dbPath, [createAdapter({ files: [livePath] })]),
    );

    expect(result.candidates.map((candidate) => [candidate.filePath, candidate.reasons])).toEqual([
      [oldPath, ['suppressed']],
      [agedPath, ['aged']],
    ]);
  });

  it('renders structured JSON output', async () => {
    const dbPath = await createTempDbPath('prune-json-');
    const oldPath = '/tmp/old.jsonl';
    const livePath = '/tmp/live.jsonl';
    const store = await openEventStore(dbPath);

    try {
      writeStoredFile(store, {
        filePath: oldPath,
        events: [createEvent({ sessionId: 'moved-session' })],
      });
      writeStoredFile(store, {
        filePath: livePath,
        events: [createEvent({ sessionId: 'moved-session' })],
      });
    } finally {
      closeEventStore(store);
    }

    const stdout = captureStdout();

    try {
      await runPruneReport(
        { suppressed: true, json: true },
        createDeps(dbPath, [createAdapter({ files: [livePath] })]),
      );
    } finally {
      stdout.restore();
    }

    const parsed = JSON.parse(stdout.getOutput()) as PruneReportResult;
    expect(parsed.candidates).toEqual([
      expect.objectContaining({
        source: 'codex',
        filePath: oldPath,
        eventCount: 1,
        reasons: ['suppressed'],
      }),
    ]);
    expect(parsed.summary).toMatchObject({
      storePath: dbPath,
      applied: false,
      candidateFileCount: 1,
      candidateEventCount: 1,
    });
  });

  it('returns zero delete counts for a missing store without creating it', async () => {
    const dbPath = await createTempDbPath('prune-missing-store-');
    await rm(dbPath, { force: true });

    const result = await buildPruneReport(
      { suppressed: true, apply: true },
      createDeps(dbPath, [createAdapter({ files: [] })]),
    );

    expect(result).toEqual({
      candidates: [],
      summary: {
        storePath: dbPath,
        applied: true,
        candidateFileCount: 0,
        candidateEventCount: 0,
        deletedFileCount: 0,
        deletedEventCount: 0,
      },
    });
    await expect(stat(dbPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(renderPruneReport(result)).toContain('Deleted 0 file(s) / 0 event(s).');
  });

  it('limits discovery to the requested source filter', async () => {
    const dbPath = await createTempDbPath('prune-source-filter-');
    const store = await openEventStore(dbPath);

    closeEventStore(store);

    const codexDiscover = vi.fn(async () => []);
    const piDiscover = vi.fn(async () => []);
    const adapters: SourceAdapter[] = [
      {
        id: 'codex',
        discoverFiles: codexDiscover,
        async parseFile() {
          return [];
        },
      },
      {
        id: 'pi',
        discoverFiles: piDiscover,
        async parseFile() {
          return [];
        },
      },
    ];

    await buildPruneReport({ suppressed: true, source: 'pi' }, createDeps(dbPath, adapters));

    expect(codexDiscover).not.toHaveBeenCalled();
    expect(piDiscover).toHaveBeenCalledTimes(1);
  });

  it('can use the default adapter factory for an explicitly scoped source', async () => {
    const dbPath = await createTempDbPath('prune-default-adapters-');
    const store = await openEventStore(dbPath);

    closeEventStore(store);

    const result = await buildPruneReport(
      { suppressed: true, source: 'codex', codexDir: path.dirname(dbPath) },
      {
        getEventStoreRuntimeConfig: () => ({
          enabled: true as const,
          path: dbPath,
        }),
      },
    );

    expect(result.summary).toMatchObject({
      applied: false,
      candidateFileCount: 0,
      candidateEventCount: 0,
    });
  });

  it('throws actionable errors for missing selectors, invalid dates, disabled stores, and unsafe discovery', async () => {
    const dbPath = await createTempDbPath('prune-errors-');
    const deps = createDeps(dbPath, [createAdapter({ files: [] })]);

    await expect(buildPruneReport({}, deps)).rejects.toThrow(
      'prune requires at least one selector',
    );
    await expect(buildPruneReport({ departedBefore: '2026-1-1' }, deps)).rejects.toThrow(
      '--departed-before must use format YYYY-MM-DD',
    );
    await expect(
      buildPruneReport(
        { suppressed: true },
        {
          ...deps,
          getEventStoreRuntimeConfig: () => ({
            enabled: false,
            path: dbPath,
            disabledBy: 'environment',
          }),
        },
      ),
    ).rejects.toThrow('prune requires the event store (unset LLM_USAGE_EVENT_STORE=0)');
    await expect(
      buildPruneReport(
        { suppressed: true },
        {
          ...deps,
          getEventStoreRuntimeConfig: () => ({
            enabled: false,
            path: dbPath,
            disabledBy: 'configuration',
          }),
        },
      ),
    ).rejects.toThrow(
      'prune requires the event store (set eventStore.enabled = true in config.toml)',
    );
    await expect(
      buildPruneReport(
        { suppressed: true },
        createDeps(dbPath, [
          createAdapter({
            files: [],
            discoverError: new Error('missing source root'),
          }),
        ]),
      ),
    ).rejects.toThrow('Cannot prune safely: codex discovery failed: missing source root');
  });

  it('renders the dry-run table and summary', async () => {
    const result: PruneReportResult = {
      candidates: [
        {
          source: 'codex',
          filePath: '/tmp/old.jsonl',
          eventCount: 1,
          newestTimestamp: '2026-02-14T10:00:00.000Z',
          reasons: ['suppressed'],
        },
      ],
      summary: {
        storePath: '/tmp/events.db',
        applied: false,
        candidateFileCount: 1,
        candidateEventCount: 1,
      },
    };

    expect(renderPruneReport(result)).toContain('Would delete 1 file(s) / 1 event(s)');
    expect(renderPruneReport(result)).toContain('/tmp/old.jsonl');
  });

  it('renders apply summaries with reclaimed db, wal, and shm sizes', () => {
    const rendered = renderPruneReport({
      candidates: [],
      summary: {
        storePath: '/tmp/events.db',
        applied: true,
        candidateFileCount: 0,
        candidateEventCount: 0,
        deletedFileCount: 0,
        deletedEventCount: 0,
        sizeBefore: {
          databaseBytes: 2 * 1024 * 1024,
          walBytes: 2048,
          shmBytes: 1024,
          totalBytes: 2 * 1024 * 1024 + 3072,
        },
        sizeAfter: {
          databaseBytes: 1024 * 1024,
          walBytes: 0,
          shmBytes: 1024,
          totalBytes: 1024 * 1024 + 1024,
        },
        reclaimedBytes: 1024 * 1024 + 2048,
      },
    });

    expect(rendered).toContain('Reclaimed 1.0 MiB');
    expect(rendered).toContain('wal 2.0 KiB');
    expect(rendered).toContain('shm 1.0 KiB');
  });

  it('writes terminal output when JSON is not requested', async () => {
    const dbPath = await createTempDbPath('prune-terminal-');
    await rm(dbPath, { force: true });
    const stdout = captureStdout();

    try {
      await runPruneReport(
        { suppressed: true },
        createDeps(dbPath, [createAdapter({ files: [] })]),
      );
    } finally {
      stdout.restore();
    }

    expect(stdout.getOutput()).toContain('Event Store Prune');
    expect(stdout.getOutput()).toContain('Would delete 0 file(s) / 0 event(s)');
  });

  it('surfaces the Active config block and unknown-key warnings on prune', async () => {
    const dbPath = await createTempDbPath('prune-config-');
    await rm(dbPath, { force: true });

    const configPath = path.join(path.dirname(dbPath), 'config.toml');
    await writeFile(configPath, 'sources = ["codex"]\nmystery = true\n', 'utf8');

    const previousConfigPath = process.env.LLM_USAGE_CONFIG_PATH;
    process.env.LLM_USAGE_CONFIG_PATH = configPath;
    const stderrChunks: string[] = [];
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((message) => stderrChunks.push(String(message)));
    const stdout = captureStdout();

    try {
      await runPruneReport(
        { suppressed: true },
        createDeps(dbPath, [createAdapter({ files: [] })]),
      );
    } finally {
      stdout.restore();
      errorSpy.mockRestore();
      process.env.LLM_USAGE_CONFIG_PATH = previousConfigPath;
    }

    const stderr = stderrChunks.join('\n');
    expect(stderr).toContain('Active config:');
    expect(stderr).toContain('sources=codex');
    expect(stderr).toContain('Unknown config key(s): mystery');
  });

  it('keeps --history dataset output identical after applying --suppressed', async () => {
    const dbPath = await createTempDbPath('prune-history-invariant-');
    const tempRoot = path.dirname(dbPath);
    const oldPath = path.join(tempRoot, 'old.jsonl');
    const livePath = path.join(tempRoot, 'live.jsonl');
    const uniquePath = path.join(tempRoot, 'unique.jsonl');
    const liveEvent = createEvent({ sessionId: 'live-path' });
    const uniqueEvent = createEvent({
      sessionId: 'unique',
      timestamp: '2026-02-14T10:05:00.000Z',
      inputTokens: 99,
      totalTokens: 104,
    });
    const store = await openEventStore(dbPath);

    await writeFile(livePath, '{}\n', 'utf8');

    try {
      writeStoredFile(store, {
        filePath: oldPath,
        events: [createEvent({ sessionId: 'live-path' })],
        now: 1_000,
      });
      writeStoredFile(store, {
        filePath: livePath,
        events: [liveEvent],
        now: 2_000,
      });
      writeStoredFile(store, {
        filePath: uniquePath,
        events: [uniqueEvent],
        now: 3_000,
      });
    } finally {
      closeEventStore(store);
    }

    const adapter = createAdapter({
      files: [livePath],
      eventsByFile: new Map([[livePath, [liveEvent]]]),
    });
    const datasetDeps = {
      createAdapters: () => [adapter],
      getEventStoreRuntimeConfig: () => ({
        enabled: true as const,
        path: dbPath,
      }),
    };
    const before = await buildUsageEventDataset(
      { history: true, source: 'codex', timezone: 'UTC' },
      datasetDeps,
    );

    await buildPruneReport(
      { suppressed: true, apply: true, source: 'codex' },
      createDeps(dbPath, [adapter]),
    );

    const after = await buildUsageEventDataset(
      { history: true, source: 'codex', timezone: 'UTC' },
      datasetDeps,
    );

    expect(after.filteredEvents).toEqual(before.filteredEvents);
  });

  it('classifies a larger mixed fixture through prune (suppressed + aged + kept)', async () => {
    const dbPath = await createTempDbPath('prune-mixed-batch-');
    const tempRoot = path.dirname(dbPath);
    const livePath = path.join(tempRoot, 'live.jsonl');
    const store = await openEventStore(dbPath);

    try {
      // Discovered live file — its content seeds the served set.
      writeStoredFile(store, {
        filePath: livePath,
        events: [createEvent({ sessionId: 'live' })],
        now: 5_000,
      });
      // Exact copies of live content — suppressed.
      for (let index = 0; index < 3; index += 1) {
        writeStoredFile(store, {
          filePath: path.join(tempRoot, `copy-${index}.jsonl`),
          events: [createEvent({ sessionId: 'live' })],
          now: 1_000 + index,
        });
      }
      // Old, unique content — aged.
      for (let index = 0; index < 3; index += 1) {
        writeStoredFile(store, {
          filePath: path.join(tempRoot, `aged-${index}.jsonl`),
          events: [
            createEvent({
              sessionId: `aged-${index}`,
              timestamp: '2025-12-30T10:00:00.000Z',
              inputTokens: 200 + index,
              totalTokens: 205 + index,
            }),
          ],
          now: 2_000 + index,
        });
      }
      // Recent, unique content — neither suppressed nor aged, so kept.
      for (let index = 0; index < 2; index += 1) {
        writeStoredFile(store, {
          filePath: path.join(tempRoot, `keep-${index}.jsonl`),
          events: [
            createEvent({
              sessionId: `keep-${index}`,
              inputTokens: 400 + index,
              totalTokens: 405 + index,
            }),
          ],
          now: 3_000 + index,
        });
      }
    } finally {
      closeEventStore(store);
    }

    const result = await buildPruneReport(
      { suppressed: true, departedBefore: '2026-01-01' },
      createDeps(dbPath, [createAdapter({ files: [livePath] })]),
    );

    const reasonsByFile = Object.fromEntries(
      result.candidates.map((candidate) => [path.basename(candidate.filePath), candidate.reasons]),
    );
    expect(reasonsByFile).toEqual({
      'copy-0.jsonl': ['suppressed'],
      'copy-1.jsonl': ['suppressed'],
      'copy-2.jsonl': ['suppressed'],
      'aged-0.jsonl': ['aged'],
      'aged-1.jsonl': ['aged'],
      'aged-2.jsonl': ['aged'],
    });
    expect(result.summary).toMatchObject({
      applied: false,
      candidateFileCount: 6,
      candidateEventCount: 6,
    });
  });
});
