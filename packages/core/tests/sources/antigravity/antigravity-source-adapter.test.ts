import { copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getFileFingerprint } from '../../../src/sources/parse-fingerprint.js';
import { getDefaultAntigravityConversationsDir } from '../../../src/sources/antigravity/antigravity-path-resolver.js';
import { AntigravitySourceAdapter } from '../../../src/sources/antigravity/index.js';
import { createSourceContext } from '../../../src/sources/source-context.js';
import { collect, collectFile } from '../../../src/stream/collect.js';
import {
  createAntigravityFixtureDb,
  encodeAntigravityGenMetadataBlob,
} from '../../helpers/antigravity-fixtures.js';
import { canCountOpenFds, countOpenFds, waitForOpenFdCount } from '../../helpers/open-fds.js';
import {
  canBeginExclusive,
  loadDatabaseSync,
  readJournalMode,
  requireDatabaseSync,
} from '../../helpers/sqlite.js';

const tempDirs: string[] = [];
const DatabaseSync = loadDatabaseSync();

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('getDefaultAntigravityConversationsDir', () => {
  it('uses GEMINI_CLI_HOME before the default .gemini directory', () => {
    expect(
      getDefaultAntigravityConversationsDir(
        createSourceContext({
          homeDir: '/home/tester',
          env: { GEMINI_CLI_HOME: '/custom/gemini' },
        }),
      ),
    ).toBe(path.join('/custom/gemini', 'antigravity-cli', 'conversations'));

    expect(
      getDefaultAntigravityConversationsDir(
        createSourceContext({
          homeDir: '/home/tester',
          env: { GEMINI_CLI_HOME: '   ' },
        }),
      ),
    ).toBe(path.join('/home/tester', '.gemini', 'antigravity-cli', 'conversations'));
  });
});

describe.skipIf(!DatabaseSync)('AntigravitySourceAdapter', () => {
  it('parses turn usage from protobuf blobs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-source-adapter-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'conversation-a.db');

    createAntigravityFixtureDb(dbPath, {
      turns: [
        {
          model: 'gemini-3-pro',
          timestamp: { seconds: 1_775_044_800, nanos: 123_000_000 },
          timestampWrapper: { unsafeVarint: 2n ** 63n + 5n },
          usage: {
            modelEnum: 1_016,
            inputTokens: 1_200,
            cacheReadTokens: 20,
            outputTokens: 30,
            reasoningTokens: 9,
            responseId: 'response-a',
          },
        },
      ],
    });

    const adapter = new AntigravitySourceAdapter({ dir: tempDir });
    const diagnostics = await collectFile(adapter, dbPath);

    expect(diagnostics).toMatchObject({
      skippedRows: 0,
      skippedRowReasons: [],
    });
    expect(diagnostics.events).toHaveLength(1);
    expect(diagnostics.events[0]).toMatchObject({
      source: 'antigravity',
      sessionId: 'conversation-a',
      timestamp: '2026-04-01T12:00:00.123Z',
      provider: undefined,
      model: 'gemini-3-pro',
      inputTokens: 1_200,
      // Visible output 30 plus 9 thinking tokens; reasoning stays a breakdown of output.
      outputTokens: 39,
      reasoningTokens: 9,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      totalTokens: 1_259,
    });
  });

  it('uses session metadata as a timestamp fallback', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-session-fallback-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'fallback.db');

    createAntigravityFixtureDb(dbPath, {
      sessionCreatedAt: { seconds: 1_775_131_200 },
      turns: [
        {
          model: 'gemini-fallback',
          usage: {
            inputTokens: 15,
            totalOutputTokens: 7,
            outputTokens: 4,
            reasoningTokens: 3,
            responseId: 'fallback-response',
          },
        },
      ],
    });

    const adapter = new AntigravitySourceAdapter();
    const events = await collect(adapter.read(dbPath));

    expect(events).toHaveLength(1);
    expect(events[0]?.timestamp).toBe('2026-04-02T12:00:00.000Z');
    expect(events[0]).toMatchObject({
      sessionId: 'fallback',
      inputTokens: 15,
      outputTokens: 7,
      reasoningTokens: 3,
      totalTokens: 22,
    });
  });

  it('deduplicates repeated response ids and records skip reasons', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-diagnostics-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'diagnostics.db');

    createAntigravityFixtureDb(dbPath, {
      turns: [
        {
          model: 'gemini-first',
          timestamp: { seconds: 1_775_044_800 },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            responseId: 'same-response',
          },
        },
        {
          model: 'gemini-duplicate',
          timestamp: { seconds: 1_775_044_801 },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            responseId: 'same-response',
          },
        },
        {
          model: 'gemini-zero',
          timestamp: { seconds: 1_775_044_802 },
          usage: {
            // The model enum in field 1 is not token usage.
            modelEnum: 1_016,
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            responseId: 'zero-response',
          },
        },
        {
          model: 'gemini-no-time',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            responseId: 'no-time-response',
          },
        },
        {
          rawBlob: new Uint8Array([0x08, 0x80]),
        },
      ],
    });

    const adapter = new AntigravitySourceAdapter();
    const diagnostics = await collectFile(adapter, dbPath);

    expect(diagnostics.events.map((event) => event.model)).toEqual(['gemini-first']);
    expect(diagnostics.skippedRows).toBe(3);
    expect(diagnostics.skippedRowReasons).toEqual([
      { reason: 'invalid_payload', count: 1 },
      { reason: 'invalid_timestamp', count: 1 },
      { reason: 'no_token_usage', count: 1 },
    ]);
  });

  it('treats DBs without gen_metadata as empty non-Antigravity files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-empty-db-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'not-antigravity.db');

    createAntigravityFixtureDb(dbPath, {
      createGenMetadataTable: false,
      sessionCreatedAt: { seconds: 1_775_044_800 },
    });

    const adapter = new AntigravitySourceAdapter();

    await expect(collectFile(adapter, dbPath)).resolves.toEqual({
      events: [],
      skippedRows: 0,
      skippedRowReasons: [],
    });
  });

  it('discovers non-recursive .db files from explicit and default conversation directories', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-discovery-'));
    tempDirs.push(tempDir);
    const explicitDir = path.join(tempDir, 'explicit');
    const nestedDir = path.join(explicitDir, 'nested');
    const defaultDir = path.join(tempDir, '.gemini', 'antigravity-cli', 'conversations');
    const explicitDbPath = path.join(explicitDir, 'explicit.db');
    const defaultDbPath = path.join(defaultDir, 'default.db');
    await mkdir(nestedDir, { recursive: true });
    await mkdir(defaultDir, { recursive: true });
    await writeFile(explicitDbPath, '', 'utf8');
    await writeFile(path.join(explicitDir, 'not-db.txt'), '', 'utf8');
    await writeFile(path.join(nestedDir, 'nested.db'), '', 'utf8');
    await writeFile(defaultDbPath, '', 'utf8');

    const explicitAdapter = new AntigravitySourceAdapter({
      dir: explicitDir,
      requireDir: true,
    });
    const defaultAdapter = new AntigravitySourceAdapter({
      context: createSourceContext({ homeDir: tempDir, env: {} }),
    });

    await expect(explicitAdapter.discoverFiles()).resolves.toEqual([
      await realpath(explicitDbPath),
    ]);
    await expect(defaultAdapter.discoverFiles()).resolves.toEqual([await realpath(defaultDbPath)]);
  });

  it('returns no discovered files when the default conversation directory is missing', async () => {
    const adapter = new AntigravitySourceAdapter({
      context: createSourceContext({
        homeDir: path.join(os.tmpdir(), `missing-antigravity-${Date.now()}`),
        env: {},
      }),
    });

    await expect(adapter.discoverFiles()).resolves.toEqual([]);
  });

  it('fails discovery when explicit conversation directory is blank, missing, or not a directory', async () => {
    const blankAdapter = new AntigravitySourceAdapter({
      dir: '   ',
      requireDir: true,
    });

    await expect(blankAdapter.discoverFiles()).rejects.toThrow(
      'Antigravity conversations directory must be a non-empty path',
    );

    const missingAdapter = new AntigravitySourceAdapter({
      dir: path.join(os.tmpdir(), `missing-antigravity-${Date.now()}`),
      requireDir: true,
    });

    await expect(missingAdapter.discoverFiles()).rejects.toThrow(
      'Antigravity conversations directory is missing or unreadable',
    );

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-file-dir-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'conversation.db');
    await writeFile(filePath, '', 'utf8');
    const fileAdapter = new AntigravitySourceAdapter({
      dir: filePath,
      requireDir: true,
    });

    await expect(fileAdapter.discoverFiles()).rejects.toThrow(
      `Antigravity conversations directory is not a directory: ${filePath}`,
    );
  });

  it('validates parse DB paths before opening sqlite', async () => {
    const adapter = new AntigravitySourceAdapter();

    await expect(collectFile(adapter, '   ')).rejects.toThrow(
      'Antigravity DB path must be a non-empty path',
    );

    const unreadableAdapter = new AntigravitySourceAdapter({
      pathReadable: async () => false,
    });

    await expect(collectFile(unreadableAdapter, '/tmp/antigravity.db')).rejects.toThrow(
      'Antigravity DB path is unreadable: /tmp/antigravity.db',
    );

    const directoryAdapter = new AntigravitySourceAdapter({
      pathExists: async () => true,
      pathReadable: async () => true,
      pathIsFile: async () => false,
    });

    await expect(collectFile(directoryAdapter, '/tmp/antigravity-dir')).rejects.toThrow(
      'Antigravity DB path is not a file: /tmp/antigravity-dir',
    );
  });

  it('keeps its cache key across reads of a WAL database but not across writes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-wal-fingerprint-'));
    tempDirs.push(tempDir);
    const writerPath = path.join(tempDir, 'writer.db');
    const dbPath = path.join(tempDir, 'conversation-wal.db');
    const turn = {
      model: 'gemini-3-pro',
      timestamp: { seconds: 1_775_044_800 },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const Database = DatabaseSync;

    if (!Database) {
      throw new Error('node:sqlite is required for this test');
    }

    createAntigravityFixtureDb(writerPath, { turns: [turn] });

    // Snapshot the files while a writer holds uncheckpointed commits, as a closed CLI
    // leaves them: a reader then has to rebuild the -shm index, which bumps its mtime.
    const writer = new Database(writerPath);

    try {
      writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      writer
        .prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)')
        .run(1, encodeAntigravityGenMetadataBlob(turn));

      for (const suffix of ['', '-wal', '-shm']) {
        await copyFile(`${writerPath}${suffix}`, `${dbPath}${suffix}`);
      }
    } finally {
      writer.close();
    }

    const adapter = new AntigravitySourceAdapter({ dir: tempDir });
    const before = await getFileFingerprint(adapter, dbPath);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await collectFile(adapter, dbPath)).events).toHaveLength(2);
    expect(await getFileFingerprint(adapter, dbPath)).toEqual(before);

    const appender = new Database(dbPath);

    try {
      const { mtimeMs: dbMtimeMs } = await stat(dbPath);
      appender
        .prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)')
        .run(2, encodeAntigravityGenMetadataBlob(turn));

      // The new commit is only in -wal, so -wal must stay part of the cache key.
      expect((await stat(dbPath)).mtimeMs).toBe(dbMtimeMs);
      expect(await getFileFingerprint(adapter, dbPath)).not.toEqual(before);
      expect((await collectFile(adapter, dbPath)).events).toHaveLength(3);
    } finally {
      appender.close();
    }
  });

  it('reports sqlite sidecars as parse dependencies', async () => {
    const adapter = new AntigravitySourceAdapter();

    await expect(adapter.getParseDependencies('/tmp/conversation.db')).resolves.toEqual([
      '/tmp/conversation.db-wal',
      '/tmp/conversation.db-journal',
    ]);
    await expect(adapter.getParseDependencies('   ')).resolves.toEqual([]);
  });

  it.runIf(canCountOpenFds)(
    'closes the database and frees it for a writer when the consumer stops early',
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-early-return-'));
      tempDirs.push(tempDir);
      const dbPath = path.join(tempDir, 'conversation-early.db');
      const turnCount = 3;
      createAntigravityFixtureDb(dbPath, {
        sessionCreatedAt: { seconds: 1_775_044_800 },
        turns: Array.from({ length: turnCount }, (_, index) => ({
          model: 'gemini-3-pro',
          usage: { inputTokens: 100, outputTokens: 10, responseId: `response-${index}` },
        })),
      });
      expect(readJournalMode(dbPath)).toBe('delete');
      const adapter = new AntigravitySourceAdapter({ dir: tempDir });
      const before = countOpenFds();

      for await (const event of adapter.read(dbPath)) {
        expect(event.sessionId).toBe('conversation-early');
        break;
      }

      await waitForOpenFdCount(before);
      expect(canBeginExclusive(dbPath)).toBe(true);
      await expect(collect(adapter.read(dbPath))).resolves.toHaveLength(turnCount);
    },
  );

  it('reports a failing first gen_metadata row before the session timestamp query', async () => {
    const rowError = new Error('gen_metadata row failed');
    const queries: string[] = [];
    const adapter = new AntigravitySourceAdapter({
      pathReadable: async () => true,
      pathExists: async () => true,
      pathIsFile: async () => true,
      loadSqliteModule: async () => ({
        DatabaseSync: class {
          public prepare(sql: string) {
            queries.push(sql);

            if (sql.includes('sqlite_master')) {
              return { all: () => [{ name: 'gen_metadata' }] };
            }

            if (sql.includes('trajectory_metadata_blob')) {
              throw new Error('session timestamp query failed');
            }

            return {
              all: () => [],
              iterate: (): IterableIterator<Record<string, unknown>> => ({
                next(): IteratorResult<Record<string, unknown>> {
                  throw rowError;
                },
                [Symbol.iterator]() {
                  return this;
                },
              }),
            };
          }

          public close(): void {
            // nothing to release in the fake database
          }
        },
      }),
    });

    const error = await collect(adapter.read('/tmp/conversation.db')).catch(
      (readError: unknown) => readError as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Could not read Antigravity DB at /tmp/conversation.db: gen_metadata row failed',
    );
    expect((error as Error).cause).toBe(rowError);
    expect(queries.some((query) => query.includes('trajectory_metadata_blob'))).toBe(false);
  });

  it('waits out a writer that holds the database locked', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-locked-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'locked.db');
    createAntigravityFixtureDb(dbPath, {
      sessionCreatedAt: { seconds: 1_775_131_200 },
      turns: [{ model: 'gemini-locked', usage: { inputTokens: 5, outputTokens: 2 } }],
    });
    const writer = new (requireDatabaseSync())(dbPath);
    writer.exec('BEGIN EXCLUSIVE');
    const delays: number[] = [];
    const adapter = new AntigravitySourceAdapter({
      sleep: async (delayMs) => {
        delays.push(delayMs);
        writer.exec('COMMIT');
      },
    });

    try {
      const events = await collect(adapter.read(dbPath));

      expect(events.map((event) => event.model)).toEqual(['gemini-locked']);
      expect(delays).toEqual([50]);
    } finally {
      writer.close();
    }
  });
});

type FakeAntigravityStep = 'open' | 'tables' | 'trajectory';

type FakeAntigravityScenario = {
  tables?: string[];
  models: string[];
  /** Errors thrown, one per call, by each step before it succeeds. */
  stepErrors?: Partial<Record<FakeAntigravityStep, Error[]>>;
  /** One entry per gen_metadata query: `iterate` throws `error` after `afterRows` rows. */
  rowErrors?: ({ afterRows: number; error: Error } | undefined)[];
  calls: string[];
};

function createBusyError(): Error {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_BUSY' });
}

function* iterateUntilError(
  rows: Record<string, unknown>[],
  rowError: { afterRows: number; error: Error } | undefined,
): Generator<Record<string, unknown>> {
  for (const [index, row] of rows.entries()) {
    if (index === rowError?.afterRows) {
      break;
    }

    yield row;
  }

  if (rowError) {
    throw rowError.error;
  }
}

function createFakeAntigravityAdapter(scenario: FakeAntigravityScenario): AntigravitySourceAdapter {
  const tables = scenario.tables ?? ['gen_metadata', 'trajectory_metadata_blob'];
  const rows = scenario.models.map((model, index) => ({
    data: encodeAntigravityGenMetadataBlob({
      model,
      timestamp: { seconds: 1_775_044_800 },
      usage: { inputTokens: 1, outputTokens: 2, responseId: `response-${index}` },
    }),
  }));
  const failStep = (step: FakeAntigravityStep): void => {
    const error = scenario.stepErrors?.[step]?.shift();

    if (error) {
      throw error;
    }
  };

  class FakeDatabase {
    public constructor() {
      failStep('open');
      scenario.calls.push('open');
    }

    public prepare(sql: string) {
      if (sql.includes('sqlite_master')) {
        return {
          all: (tableName: unknown) => {
            failStep('tables');
            return tables.includes(String(tableName)) ? [{ name: tableName }] : [];
          },
        };
      }

      if (sql.includes('trajectory_metadata_blob')) {
        return {
          all: () => {
            failStep('trajectory');
            return [];
          },
        };
      }

      const rowError = scenario.rowErrors?.shift();

      return {
        all: () => rows,
        iterate: () => iterateUntilError(rows, rowError),
      };
    }

    public close(): void {
      scenario.calls.push('close');
    }
  }

  return new AntigravitySourceAdapter({
    pathReadable: async () => true,
    pathExists: async () => true,
    pathIsFile: async () => true,
    maxBusyRetries: 3,
    busyRetryDelayMs: 5,
    sleep: async (delayMs) => {
      scenario.calls.push(`sleep ${delayMs}`);
    },
    loadSqliteModule: async () => ({ DatabaseSync: FakeDatabase }),
  });
}

describe('AntigravitySourceAdapter busy retry boundary (every query before the first row)', () => {
  const dbPath = '/tmp/conversation.db';
  const busyMessage = (attempts: number): string =>
    `Antigravity DB is busy/locked: ${dbPath}. Retries exhausted after ${attempts} attempt(s). Close active Antigravity processes and retry.`;
  const ioError = (): Error => Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });

  async function readUntilError(
    scenario: FakeAntigravityScenario,
  ): Promise<{ models: string[]; error: Error }> {
    const models: string[] = [];

    try {
      for await (const event of createFakeAntigravityAdapter(scenario).read(dbPath)) {
        models.push(event.model ?? '');
      }
    } catch (error) {
      return { models, error: error as Error };
    }

    throw new Error('expected the read to fail');
  }

  it('retries a busy open, table check, first row and session timestamp query', async () => {
    const calls: string[] = [];
    const adapter = createFakeAntigravityAdapter({
      models: ['m-1', 'm-2'],
      stepErrors: { open: [createBusyError()], tables: [createBusyError()] },
      rowErrors: [{ afterRows: 0, error: createBusyError() }, undefined],
      calls,
    });
    const busyTimestampAdapter = createFakeAntigravityAdapter({
      models: ['m-1'],
      stepErrors: { trajectory: [createBusyError()] },
      calls: [],
    });

    const events = await collect(adapter.read(dbPath));

    expect(events.map((event) => event.model)).toEqual(['m-1', 'm-2']);
    expect(calls).toEqual([
      'sleep 5',
      'open',
      'close',
      'sleep 10',
      'open',
      'close',
      'sleep 15',
      'open',
      'close',
    ]);
    await expect(collect(busyTimestampAdapter.read(dbPath))).resolves.toHaveLength(1);
  });

  it('retries a busy table check that then finds no gen_metadata, closing every attempt', async () => {
    const calls: string[] = [];
    const adapter = createFakeAntigravityAdapter({
      tables: [],
      models: [],
      stepErrors: { tables: [createBusyError()] },
      calls,
    });

    await expect(collect(adapter.read(dbPath))).resolves.toEqual([]);
    expect(calls).toEqual(['open', 'close', 'sleep 5', 'open', 'close']);
  });

  it('rewrites a busy session timestamp query that exhausts the retries', async () => {
    const calls: string[] = [];
    const busyError = createBusyError();
    const result = await readUntilError({
      models: ['m-1'],
      stepErrors: {
        trajectory: [createBusyError(), createBusyError(), createBusyError(), busyError],
      },
      calls,
    });

    expect(result.error.message).toBe(busyMessage(4));
    expect(result.error.cause).toBe(busyError);
    expect(result.models).toEqual([]);
    expect(calls.filter((call) => call === 'close')).toHaveLength(4);
  });

  it('rewrites a non-busy table check without retrying', async () => {
    const calls: string[] = [];
    const tableError = ioError();
    const result = await readUntilError({
      models: ['m-1'],
      stepErrors: { tables: [tableError] },
      calls,
    });

    expect(result.error.message).toBe(
      `Could not read Antigravity DB at ${dbPath}: SQLITE_IOERR: disk I/O error`,
    );
    expect(result.error.cause).toBe(tableError);
    expect(calls).toEqual(['open', 'close']);
  });

  it('does not retry a busy row after the first, so no row is yielded twice', async () => {
    const calls: string[] = [];
    const busyError = createBusyError();
    const result = await readUntilError({
      models: ['m-1', 'm-2', 'm-3'],
      stepErrors: { open: [createBusyError()] },
      rowErrors: [{ afterRows: 2, error: busyError }],
      calls,
    });

    expect(result.error.message).toBe(busyMessage(2));
    expect(result.error.cause).toBe(busyError);
    expect(result.models).toEqual(['m-1', 'm-2']);
    expect(calls).toEqual(['sleep 5', 'open', 'close']);
  });
});
