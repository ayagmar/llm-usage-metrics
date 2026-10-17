import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getDefaultGooseDbPathCandidates } from '../../../src/sources/goose/goose-db-path-resolver.js';
import { GooseSourceAdapter } from '../../../src/sources/goose/index.js';
import { createSourceContext } from '../../../src/sources/source-context.js';
import { collect, collectFile } from '../../../src/stream/collect.js';
import { canCountOpenFds, countOpenFds, waitForOpenFdCount } from '../../helpers/open-fds.js';
import {
  canBeginExclusive,
  readJournalMode,
  requireDatabaseSync,
  withSuppressedSqliteExperimentalWarning,
} from '../../helpers/sqlite.js';

type FixtureDatabaseSync = new (filePath: string) => {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...args: unknown[]) => void };
  close: () => void;
};

type GooseSessionFixture = {
  id: string;
  modelConfigJson: string;
  providerName: string;
  createdAt: string | number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  accumulatedTotalTokens?: number | null;
  accumulatedInputTokens?: number | null;
  accumulatedOutputTokens?: number | null;
};

const require = createRequire(import.meta.url);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function loadDatabaseSync(): FixtureDatabaseSync | undefined {
  let sqliteModule: unknown;

  try {
    sqliteModule = withSuppressedSqliteExperimentalWarning(() => require('node:sqlite') as unknown);
  } catch {
    return undefined;
  }

  const moduleRecord = sqliteModule as { DatabaseSync?: unknown } | undefined;

  if (typeof moduleRecord?.DatabaseSync !== 'function') {
    return undefined;
  }

  return moduleRecord.DatabaseSync as FixtureDatabaseSync;
}

function createGooseFixtureDb(dbPath: string, sessions: GooseSessionFixture[]): void {
  const DatabaseSync = loadDatabaseSync();

  if (!DatabaseSync) {
    throw new Error('Goose fixtures require node:sqlite DatabaseSync support.');
  }

  const database = new DatabaseSync(dbPath);

  try {
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        model_config_json TEXT,
        provider_name TEXT,
        created_at TEXT,
        total_tokens INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        accumulated_total_tokens INTEGER,
        accumulated_input_tokens INTEGER,
        accumulated_output_tokens INTEGER
      );
    `);

    const insertSession = database.prepare(`
      INSERT INTO sessions (
        id,
        model_config_json,
        provider_name,
        created_at,
        total_tokens,
        input_tokens,
        output_tokens,
        accumulated_total_tokens,
        accumulated_input_tokens,
        accumulated_output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const session of sessions) {
      insertSession.run(
        session.id,
        session.modelConfigJson,
        session.providerName,
        session.createdAt,
        session.totalTokens,
        session.inputTokens,
        session.outputTokens,
        session.accumulatedTotalTokens ?? null,
        session.accumulatedInputTokens ?? null,
        session.accumulatedOutputTokens ?? null,
      );
    }
  } finally {
    database.close();
  }
}

const DatabaseSync = loadDatabaseSync();

describe('getDefaultGooseDbPathCandidates', () => {
  it('resolves Linux candidates from XDG data home and legacy Block path', () => {
    expect(
      getDefaultGooseDbPathCandidates(
        createSourceContext({
          homeDir: '/home/tester',
          platform: 'linux',
          env: { XDG_DATA_HOME: '/xdg-data' },
        }),
      ),
    ).toEqual([
      path.join('/xdg-data', 'goose', 'sessions', 'sessions.db'),
      path.join('/home/tester', '.local', 'share', 'Block', 'goose', 'sessions', 'sessions.db'),
    ]);
  });

  it('resolves macOS candidates from Application Support and legacy Block path', () => {
    expect(
      getDefaultGooseDbPathCandidates(
        createSourceContext({
          homeDir: '/Users/tester',
          platform: 'darwin',
          env: {},
        }),
      ),
    ).toEqual([
      path.join(
        '/Users/tester',
        'Library',
        'Application Support',
        'goose',
        'sessions',
        'sessions.db',
      ),
      path.join('/Users/tester', '.local', 'share', 'Block', 'goose', 'sessions', 'sessions.db'),
    ]);
  });

  it('resolves Windows candidates from APPDATA or USERPROFILE fallback', () => {
    expect(
      getDefaultGooseDbPathCandidates(
        createSourceContext({
          homeDir: '/home/tester',
          platform: 'win32',
          env: { APPDATA: '/roaming' },
        }),
      ),
    ).toEqual([
      path.join('/roaming', 'goose', 'sessions', 'sessions.db'),
      path.join('/home/tester', '.local', 'share', 'Block', 'goose', 'sessions', 'sessions.db'),
    ]);

    expect(
      getDefaultGooseDbPathCandidates(
        createSourceContext({
          homeDir: '/home/tester',
          platform: 'win32',
          env: { USERPROFILE: '/profile' },
        }),
      )[0],
    ).toBe(path.join('/profile', 'AppData', 'Roaming', 'goose', 'sessions', 'sessions.db'));
  });
});

describe.skipIf(!DatabaseSync)('GooseSourceAdapter', () => {
  it('parses session aggregate rows and records malformed model config diagnostics', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'goose-source-adapter-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'sessions.db');

    createGooseFixtureDb(dbPath, [
      {
        id: 'goose-accumulated',
        modelConfigJson: JSON.stringify({ model_name: 'gpt-goose' }),
        providerName: 'openai',
        createdAt: '2026-04-01T10:00:00.000Z',
        totalTokens: 15,
        inputTokens: 5,
        outputTokens: 5,
        accumulatedTotalTokens: 150,
        accumulatedInputTokens: 100,
        accumulatedOutputTokens: 30,
      },
      {
        id: 'goose-plain',
        modelConfigJson: '{',
        providerName: 'anthropic',
        createdAt: '2026-04-02 03:04:05',
        totalTokens: 20,
        inputTokens: 10,
        outputTokens: 5,
      },
      {
        id: 'goose-epoch',
        modelConfigJson: JSON.stringify({ model_name: 'claude-goose' }),
        providerName: 'anthropic',
        createdAt: 1_775_044_800,
        totalTokens: 5,
        inputTokens: 2,
        outputTokens: 3,
      },
      {
        id: 'goose-zero',
        modelConfigJson: JSON.stringify({ model_name: 'zero-goose' }),
        providerName: 'openai',
        createdAt: '2026-04-03T10:00:00.000Z',
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      {
        id: 'goose-invalid-time',
        modelConfigJson: JSON.stringify({ model_name: 'bad-time-goose' }),
        providerName: 'openai',
        createdAt: 'not-a-date',
        totalTokens: 3,
        inputTokens: 1,
        outputTokens: 2,
      },
    ]);

    const adapter = new GooseSourceAdapter({ dbPath });
    const diagnostics = await collectFile(adapter, dbPath);

    expect(diagnostics.skippedRows).toBe(3);
    expect(diagnostics.skippedRowReasons).toEqual([
      { reason: 'invalid_model_config', count: 1 },
      { reason: 'invalid_timestamp', count: 1 },
      { reason: 'no_token_usage', count: 1 },
    ]);
    expect(diagnostics.events).toHaveLength(3);
    expect(diagnostics.events[0]).toMatchObject({
      source: 'goose',
      sessionId: 'goose-accumulated',
      provider: 'openai',
      model: 'gpt-goose',
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 20,
      totalTokens: 150,
    });
    expect(diagnostics.events[1]).toMatchObject({
      sessionId: 'goose-plain',
      provider: 'anthropic',
      model: undefined,
      inputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 5,
      totalTokens: 20,
    });
    expect(diagnostics.events[1]?.timestamp).toBe('2026-04-02T03:04:05.000Z');
    expect(diagnostics.events[2]).toMatchObject({
      sessionId: 'goose-epoch',
      model: 'claude-goose',
      timestamp: '2026-04-01T12:00:00.000Z',
      totalTokens: 5,
    });
  });

  it('declares the SQLite -wal and -journal sidecars as parse dependencies', async () => {
    const adapter = new GooseSourceAdapter();

    await expect(adapter.getParseDependencies(' /data/sessions.db ')).resolves.toEqual([
      '/data/sessions.db-wal',
      '/data/sessions.db-journal',
    ]);
    await expect(adapter.getParseDependencies('  ')).resolves.toEqual([]);
  });

  it('uses GOOSE_PATH_ROOT before other default DB candidates', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'goose-env-root-'));
    tempDirs.push(tempDir);
    const goosePathRoot = path.join(tempDir, 'goose-root');
    const xdgDataHome = path.join(tempDir, 'xdg-data');
    const envDbPath = path.join(goosePathRoot, 'data', 'sessions', 'sessions.db');
    const xdgDbPath = path.join(xdgDataHome, 'goose', 'sessions', 'sessions.db');
    await mkdir(path.dirname(envDbPath), { recursive: true });
    await mkdir(path.dirname(xdgDbPath), { recursive: true });
    await writeFile(envDbPath, '', 'utf8');
    await writeFile(xdgDbPath, '', 'utf8');

    const adapter = new GooseSourceAdapter({
      resolveDefaultDbPaths: () =>
        getDefaultGooseDbPathCandidates(
          createSourceContext({
            homeDir: tempDir,
            platform: 'linux',
            env: {
              GOOSE_PATH_ROOT: goosePathRoot,
              XDG_DATA_HOME: xdgDataHome,
            },
          }),
        ),
    });

    await expect(adapter.discoverFiles()).resolves.toEqual([envDbPath]);
  });

  it('returns no discovered files when default DB candidates do not exist', async () => {
    const adapter = new GooseSourceAdapter({
      resolveDefaultDbPaths: () => ['/tmp/missing-goose-a.db', '/tmp/missing-goose-b.db'],
      pathExists: async () => false,
      pathReadable: async () => false,
    });

    await expect(adapter.discoverFiles()).resolves.toEqual([]);
  });

  it('fails discovery when default candidates exist unreadable or as directories', async () => {
    const unreadableAdapter = new GooseSourceAdapter({
      resolveDefaultDbPaths: () => ['/tmp/goose-unreadable.db'],
      pathExists: async () => true,
      pathReadable: async () => false,
    });

    await expect(unreadableAdapter.discoverFiles()).rejects.toThrow(
      'Goose DB path is unreadable: /tmp/goose-unreadable.db',
    );

    const directoryAdapter = new GooseSourceAdapter({
      resolveDefaultDbPaths: () => ['/tmp/goose-dir'],
      pathExists: async () => true,
      pathReadable: async () => true,
      pathIsFile: async () => false,
    });

    await expect(directoryAdapter.discoverFiles()).rejects.toThrow(
      'Goose DB path is not a file: /tmp/goose-dir',
    );
  });

  it('fails discovery when explicit --goose-db path is blank or missing', async () => {
    const blankAdapter = new GooseSourceAdapter({ dbPath: '   ' });

    await expect(blankAdapter.discoverFiles()).rejects.toThrow('dbPath must be a non-empty path');

    const missingAdapter = new GooseSourceAdapter({
      dbPath: path.join(os.tmpdir(), `missing-goose-${Date.now()}.db`),
    });

    await expect(missingAdapter.discoverFiles()).rejects.toThrow(
      'Goose DB path is missing or unreadable',
    );
  });

  it('validates parse DB paths before opening sqlite', async () => {
    const adapter = new GooseSourceAdapter();

    await expect(collectFile(adapter, '   ')).rejects.toThrow(
      'Goose DB path must be a non-empty path',
    );

    const unreadableAdapter = new GooseSourceAdapter({
      pathReadable: async () => false,
    });

    await expect(collectFile(unreadableAdapter, '/tmp/goose.db')).rejects.toThrow(
      'Goose DB path is unreadable: /tmp/goose.db',
    );

    const directoryAdapter = new GooseSourceAdapter({
      pathExists: async () => true,
      pathReadable: async () => true,
      pathIsFile: async () => false,
    });

    await expect(collectFile(directoryAdapter, '/tmp/goose-dir')).rejects.toThrow(
      'Goose DB path is not a file: /tmp/goose-dir',
    );
  });

  it.runIf(canCountOpenFds)(
    'closes the database and frees it for a writer when the consumer stops early',
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'goose-early-return-'));
      tempDirs.push(tempDir);
      const dbPath = path.join(tempDir, 'sessions.db');
      const rowCount = 3;
      createGooseFixtureDb(
        dbPath,
        Array.from({ length: rowCount }, (_, index) => ({
          id: `goose-${index}`,
          modelConfigJson: JSON.stringify({ model_name: 'gpt-goose' }),
          providerName: 'openai',
          createdAt: '2026-04-01T10:00:00.000Z',
          totalTokens: 15,
          inputTokens: 10,
          outputTokens: 5,
        })),
      );
      expect(readJournalMode(dbPath)).toBe('delete');
      const adapter = new GooseSourceAdapter({ dbPath });
      const before = countOpenFds();

      for await (const event of adapter.read(dbPath)) {
        expect(event.source).toBe('goose');
        break;
      }

      await waitForOpenFdCount(before);
      expect(canBeginExclusive(dbPath)).toBe(true);
      await expect(collect(adapter.read(dbPath))).resolves.toHaveLength(rowCount);
    },
  );

  it('waits out a writer that holds the database locked', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'goose-locked-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'sessions.db');
    createGooseFixtureDb(dbPath, [
      {
        id: 'goose-locked',
        modelConfigJson: JSON.stringify({ model_name: 'gpt-goose' }),
        providerName: 'openai',
        createdAt: '2026-04-01T10:00:00.000Z',
        totalTokens: 15,
        inputTokens: 10,
        outputTokens: 5,
      },
    ]);
    const writer = new (requireDatabaseSync())(dbPath);
    writer.exec('BEGIN EXCLUSIVE');
    const delays: number[] = [];
    const adapter = new GooseSourceAdapter({
      dbPath,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        writer.exec('COMMIT');
      },
    });

    try {
      const events = await collect(adapter.read(dbPath));

      expect(events.map((event) => event.sessionId)).toEqual(['goose-locked']);
      expect(delays).toEqual([50]);
    } finally {
      writer.close();
    }
  });
});

type FakeGooseScenario = {
  rows: Record<string, unknown>[];
  openErrors?: Error[];
  /** One entry per query: `iterate` throws `error` after `afterRows` rows (undefined reads all). */
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

function createFakeGooseAdapter(scenario: FakeGooseScenario): GooseSourceAdapter {
  class FakeDatabase {
    public constructor() {
      const openError = scenario.openErrors?.shift();

      if (openError) {
        throw openError;
      }

      scenario.calls.push('open');
    }

    public prepare() {
      const rowError = scenario.rowErrors?.shift();

      return {
        all: () => scenario.rows,
        iterate: () => iterateUntilError(scenario.rows, rowError),
      };
    }

    public close(): void {
      scenario.calls.push('close');
    }
  }

  return new GooseSourceAdapter({
    pathReadable: async () => true,
    pathExists: async () => true,
    pathIsFile: async () => true,
    maxBusyRetries: 2,
    busyRetryDelayMs: 5,
    sleep: async (delayMs) => {
      scenario.calls.push(`sleep ${delayMs}`);
    },
    loadSqliteModule: async () => ({ DatabaseSync: FakeDatabase }),
  });
}

describe('GooseSourceAdapter busy retry boundary (open and the first row)', () => {
  const dbPath = '/tmp/goose.db';
  const sessionRow = (id: string): Record<string, unknown> => ({
    id,
    model_config_json: JSON.stringify({ model_name: 'gpt-goose' }),
    provider_name: 'openai',
    created_at: '2026-04-01T10:00:00.000Z',
    total_tokens: 15,
    input_tokens: 10,
    output_tokens: 5,
  });
  const busyMessage = (attempts: number): string =>
    `Goose DB is busy/locked: ${dbPath}. Retries exhausted after ${attempts} attempt(s). Close active Goose processes and retry.`;
  const ioError = (): Error => Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
  const ioMessage = `Could not read Goose DB at ${dbPath}: SQLITE_IOERR: disk I/O error`;

  async function readUntilError(
    scenario: FakeGooseScenario,
  ): Promise<{ sessionIds: string[]; error: Error }> {
    const sessionIds: string[] = [];

    try {
      for await (const event of createFakeGooseAdapter(scenario).read(dbPath)) {
        sessionIds.push(event.sessionId);
      }
    } catch (error) {
      return { sessionIds, error: error as Error };
    }

    throw new Error('expected the read to fail');
  }

  it('retries a busy open and a busy first row, closing each failed attempt before waiting', async () => {
    const calls: string[] = [];
    const adapter = createFakeGooseAdapter({
      rows: [sessionRow('s-1'), sessionRow('s-2')],
      openErrors: [createBusyError()],
      rowErrors: [{ afterRows: 0, error: createBusyError() }, undefined],
      calls,
    });

    const events = await collect(adapter.read(dbPath));

    expect(events.map((event) => event.sessionId)).toEqual(['s-1', 's-2']);
    expect(calls).toEqual(['sleep 5', 'open', 'close', 'sleep 10', 'open', 'close']);
  });

  it('rewrites a busy first row that exhausts the retries', async () => {
    const calls: string[] = [];
    const busyError = createBusyError();
    const result = await readUntilError({
      rows: [sessionRow('s-1')],
      rowErrors: [
        { afterRows: 0, error: createBusyError() },
        { afterRows: 0, error: createBusyError() },
        { afterRows: 0, error: busyError },
      ],
      calls,
    });

    expect(result.error.message).toBe(busyMessage(3));
    expect(result.error.cause).toBe(busyError);
    expect(result.sessionIds).toEqual([]);
    expect(calls.filter((call) => call === 'close')).toHaveLength(3);
  });

  it('rewrites a non-busy open error without retrying', async () => {
    const calls: string[] = [];
    const openError = ioError();
    const result = await readUntilError({ rows: [], openErrors: [openError], calls });

    expect(result.error.message).toBe(ioMessage);
    expect(result.error.cause).toBe(openError);
    expect(calls).toEqual([]);
  });

  it('does not retry a busy row after the first, so no row is yielded twice', async () => {
    const calls: string[] = [];
    const busyError = createBusyError();
    const result = await readUntilError({
      rows: [sessionRow('s-1'), sessionRow('s-2'), sessionRow('s-3')],
      rowErrors: [
        { afterRows: 0, error: createBusyError() },
        { afterRows: 2, error: busyError },
      ],
      calls,
    });

    expect(result.error.message).toBe(busyMessage(2));
    expect(result.error.cause).toBe(busyError);
    expect(result.sessionIds).toEqual(['s-1', 's-2']);
    expect(calls).toEqual(['open', 'close', 'sleep 5', 'open', 'close']);
  });

  it('rewrites a non-busy row after the first without retrying', async () => {
    const calls: string[] = [];
    const rowError = ioError();
    const result = await readUntilError({
      rows: [sessionRow('s-1'), sessionRow('s-2')],
      rowErrors: [{ afterRows: 1, error: rowError }],
      calls,
    });

    expect(result.error.message).toBe(ioMessage);
    expect(result.error.cause).toBe(rowError);
    expect(result.sessionIds).toEqual(['s-1']);
    expect(calls).toEqual(['open', 'close']);
  });
});
