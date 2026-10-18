import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeSourceAdapter } from '../../../src/sources/opencode/index.js';
import { collect, collectFile } from '../../../src/stream/collect.js';
import { canCountOpenFds, countOpenFds, waitForOpenFdCount } from '../../helpers/open-fds.js';
import {
  canBeginExclusive,
  loadDatabaseSync,
  readJournalMode,
  requireDatabaseSync,
} from '../../helpers/sqlite.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

type FakeSqliteScenario = {
  tables?: string[];
  messageColumns?: string[];
  primaryRows?: Record<string, unknown>[];
  fallbackRows?: Record<string, unknown>[];
  primaryQueryErrors?: Error[];
  /**
   * One entry per primary query: the statement gets `iterate`, which throws `error` after
   * `afterRows` rows (an undefined entry reads every row).
   */
  primaryRowErrors?: ({ afterRows: number; error: Error } | undefined)[];
  openErrors?: Error[];
  seenQueries?: string[];
  calls?: string[];
};

type FakeStatement = {
  all: () => Record<string, unknown>[];
  iterate?: () => IterableIterator<Record<string, unknown>>;
};

type TestSqliteModule = {
  DatabaseSync: new (
    filePath: string,
    options?: {
      readOnly?: boolean;
      timeout?: number;
    },
  ) => {
    prepare: (sql: string) => FakeStatement;
    close: () => void;
  };
};

function createBusyError(message = 'database is locked'): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = 'SQLITE_BUSY';
  return error;
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

function createSqliteLoader(scenario: FakeSqliteScenario): () => Promise<TestSqliteModule> {
  class FakeDatabase {
    public constructor() {
      const openError = scenario.openErrors?.shift();

      if (openError) {
        throw openError;
      }

      scenario.calls?.push('open');
    }

    public prepare(sql: string): FakeStatement {
      scenario.seenQueries?.push(sql);

      if (sql.includes('sqlite_master')) {
        const tables = scenario.tables ?? ['message'];
        return {
          all: () => tables.map((name) => ({ name })),
        };
      }

      if (/PRAGMA\s+table_info\(/iu.test(sql)) {
        const columns = scenario.messageColumns ?? ['id', 'time_created', 'session_id', 'data'];
        return {
          all: () => columns.map((name) => ({ name })),
        };
      }

      if (sql.includes('json_extract(')) {
        const queryError = scenario.primaryQueryErrors?.shift();

        if (queryError) {
          throw queryError;
        }

        if (scenario.primaryRowErrors) {
          const rowError = scenario.primaryRowErrors.shift();

          return {
            all: () => {
              throw new Error('all() should not be used when iterate() is available');
            },
            iterate: () => iterateUntilError(scenario.primaryRows ?? [], rowError),
          };
        }

        return {
          all: () => scenario.primaryRows ?? [],
        };
      }

      return {
        all: () => scenario.fallbackRows ?? [],
      };
    }

    public close(): void {
      scenario.calls?.push('close');
    }
  }

  return async () => ({ DatabaseSync: FakeDatabase });
}

describe('OpenCodeSourceAdapter', () => {
  it('fails discovery when explicit --opencode-db path is blank', async () => {
    const adapter = new OpenCodeSourceAdapter({
      dbPath: '   ',
    });

    await expect(adapter.discoverFiles()).rejects.toThrow('dbPath must be a non-empty path');
  });

  it('reports parse dependencies for configured and blank db paths', async () => {
    const configuredAdapter = new OpenCodeSourceAdapter({
      dbPath: '/tmp/opencode.db',
    });
    const blankAdapter = new OpenCodeSourceAdapter({
      dbPath: '   ',
    });

    await expect(configuredAdapter.getParseDependencies('/tmp/opencode.db')).resolves.toEqual([
      '/tmp/opencode.db-wal',
      '/tmp/opencode.db-journal',
    ]);
    await expect(blankAdapter.getParseDependencies('   ')).resolves.toEqual([]);
  });

  it('fails discovery when explicit --opencode-db path is missing or unreadable', async () => {
    const adapter = new OpenCodeSourceAdapter({
      dbPath: '/tmp/missing-opencode.db',
      pathReadable: async () => false,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      'OpenCode DB path is missing or unreadable: /tmp/missing-opencode.db',
    );
  });

  it('fails discovery when explicit --opencode-db path is not a file', async () => {
    const adapter = new OpenCodeSourceAdapter({
      dbPath: '/tmp/opencode-dir',
      pathExists: async () => true,
      pathReadable: async () => true,
      pathIsFile: async () => false,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      'OpenCode DB path is not a file: /tmp/opencode-dir',
    );
  });

  it('resolves first readable default DB path when no explicit override is set', async () => {
    const adapter = new OpenCodeSourceAdapter({
      resolveDefaultDbPaths: () => ['/tmp/opencode-a.db', '/tmp/opencode-b.db'],
      pathExists: async () => false,
      pathReadable: async (filePath) => filePath === '/tmp/opencode-b.db',
    });

    await expect(adapter.discoverFiles()).resolves.toEqual(['/tmp/opencode-b.db']);
  });

  it('continues default DB discovery when an earlier candidate exists but is unreadable', async () => {
    const adapter = new OpenCodeSourceAdapter({
      resolveDefaultDbPaths: () => ['/tmp/opencode-unreadable.db', '/tmp/opencode-readable.db'],
      pathExists: async (filePath) => filePath === '/tmp/opencode-unreadable.db',
      pathReadable: async (filePath) => filePath === '/tmp/opencode-readable.db',
    });

    await expect(adapter.discoverFiles()).resolves.toEqual(['/tmp/opencode-readable.db']);
  });

  it('returns every channel database in the first directory that has one', async () => {
    const readable = new Set([
      '/data/opencode/opencode.db',
      '/data/opencode/opencode-dev.db',
      '/data/opencode/db.sqlite',
      '/home/.opencode/opencode.db',
    ]);
    const adapter = new OpenCodeSourceAdapter({
      resolveDefaultDbPaths: () => [
        '/data/opencode/opencode.db',
        '/data/opencode/opencode-dev.db',
        '/data/opencode/db.sqlite',
        '/home/.opencode/opencode.db',
      ],
      pathExists: async (filePath) => readable.has(filePath),
      pathReadable: async (filePath) => readable.has(filePath),
      pathIsFile: async () => true,
    });

    await expect(adapter.discoverFiles()).resolves.toEqual([
      '/data/opencode/opencode.db',
      '/data/opencode/opencode-dev.db',
    ]);
  });

  it('falls back to db.sqlite only when no opencode database sits beside it', async () => {
    const adapter = new OpenCodeSourceAdapter({
      resolveDefaultDbPaths: () => ['/data/opencode/opencode.db', '/data/opencode/db.sqlite'],
      pathExists: async (filePath) => filePath === '/data/opencode/db.sqlite',
      pathReadable: async (filePath) => filePath === '/data/opencode/db.sqlite',
      pathIsFile: async () => true,
    });

    await expect(adapter.discoverFiles()).resolves.toEqual(['/data/opencode/db.sqlite']);
  });

  it('fails discovery when first readable default candidate is not a file', async () => {
    const adapter = new OpenCodeSourceAdapter({
      resolveDefaultDbPaths: () => ['/tmp/opencode-candidate'],
      pathExists: async () => true,
      pathReadable: async () => true,
      pathIsFile: async () => false,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      'OpenCode DB path is not a file: /tmp/opencode-candidate',
    );
  });

  it('fails discovery when a default DB candidate exists but is unreadable', async () => {
    const adapter = new OpenCodeSourceAdapter({
      resolveDefaultDbPaths: () => ['/tmp/opencode.db'],
      pathExists: async (filePath) => filePath === '/tmp/opencode.db',
      pathReadable: async () => false,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      'OpenCode DB path is unreadable: /tmp/opencode.db',
    );
  });

  it('surfaces unreadable existing default candidate using built-in pathExists fallback', async () => {
    const existingPath = path.resolve('package.json');
    const adapter = new OpenCodeSourceAdapter({
      resolveDefaultDbPaths: () => [existingPath],
      pathReadable: async () => false,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      `OpenCode DB path is unreadable: ${existingPath}`,
    );
  });

  it('maps assistant rows into normalized usage events and skips malformed rows', async () => {
    const adapter = new OpenCodeSourceAdapter({
      pathReadable: async () => true,
      loadSqliteModule: createSqliteLoader({
        primaryRows: [
          {
            row_id: 'msg-1',
            row_session_id: 'session-1',
            row_time: 1_737_000_000,
            data_json: JSON.stringify({
              role: 'assistant',
              providerID: 'openai',
              modelID: 'gpt-5-codex',
              tokens: {
                input: 100,
                output: 40,
                reasoning: 5,
                cache: { read: 20, write: 10 },
                total: 175,
              },
              cost: 1.5,
            }),
          },
          {
            row_id: 'msg-2',
            row_session_id: 'session-2',
            row_time: 1_737_000_001,
            data_json: '{invalid',
          },
          {
            row_id: 'msg-3',
            row_session_id: 'session-3',
            row_time: 1_737_000_002,
            data_json: JSON.stringify({ role: 'assistant', modelID: 'gpt-4.1' }),
          },
          {
            row_id: 'msg-4',
            row_session_id: 'session-4',
            row_time: 1_737_000_003,
            data_json: JSON.stringify({ role: 'user', tokens: { input: 1 } }),
          },
          {
            row_id: 'msg-5',
            row_session_id: 'session-5',
            row_time: 1_737_000_004,
            data_json: JSON.stringify({
              role: 'assistant',
              modelID: 'gpt-4.1',
              tokens: { input: 0, output: 0, total: 0 },
            }),
          },
          {
            row_id: 'msg-6',
            row_session_id: 'session-6',
            row_time: 'not-a-timestamp',
            data_json: JSON.stringify({
              role: 'assistant',
              modelID: 'gpt-4.1',
              tokens: { input: 1, output: 1, total: 2 },
            }),
          },
        ],
      }),
    });

    const parseDiagnostics = await collectFile(adapter, '/tmp/opencode.db');

    expect(parseDiagnostics.events).toHaveLength(1);
    expect(parseDiagnostics.skippedRows).toBe(4);
    expect(parseDiagnostics.skippedRowReasons).toEqual([
      { reason: 'invalid_data_json', count: 1 },
      { reason: 'missing_timestamp', count: 1 },
      { reason: 'missing_usage_signal', count: 2 },
    ]);
    expect(parseDiagnostics.events[0]).toMatchObject({
      source: 'opencode',
      sessionId: 'session-1',
      timestamp: new Date(1_737_000_000 * 1000).toISOString(),
      provider: 'openai',
      model: 'gpt-5-codex',
      inputTokens: 100,
      outputTokens: 45,
      reasoningTokens: 5,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 175,
      costUsd: 1.5,
    });
  });

  it('fails parse when db path resolves to a non-file path', async () => {
    const adapter = new OpenCodeSourceAdapter({
      pathExists: async () => true,
      pathReadable: async () => true,
      pathIsFile: async () => false,
    });

    await expect(collectFile(adapter, '/tmp/opencode-directory')).rejects.toThrow(
      'OpenCode DB path is not a file: /tmp/opencode-directory',
    );
  });

  it('handles message table and columns with non-lowercase schema names', async () => {
    const adapter = new OpenCodeSourceAdapter({
      pathReadable: async () => true,
      loadSqliteModule: createSqliteLoader({
        tables: ['Message'],
        messageColumns: ['ID', 'TIME_CREATED', 'SESSION_ID', 'DATA'],
        primaryRows: [
          {
            row_id: 'msg-1',
            row_session_id: 'session-1',
            row_time: 1_737_000_000_000,
            data_json: JSON.stringify({
              role: 'assistant',
              modelID: 'gpt-4.1',
              tokens: {
                input: 10,
                output: 5,
                total: 15,
              },
            }),
          },
        ],
      }),
    });

    const events = await collect(adapter.read('/tmp/opencode.db'));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'opencode',
      sessionId: 'session-1',
      model: 'gpt-4.1',
      totalTokens: 15,
    });
  });

  it('builds primary query that filters assistant rows by role or type', async () => {
    const seenQueries: string[] = [];
    const adapter = new OpenCodeSourceAdapter({
      pathReadable: async () => true,
      loadSqliteModule: createSqliteLoader({
        primaryRows: [
          {
            row_id: 'msg-1',
            row_session_id: 'session-1',
            row_time: 1_737_000_000_000,
            data_json: JSON.stringify({
              type: 'assistant',
              modelID: 'gpt-4.1',
              tokens: { input: 10, output: 5, total: 15 },
            }),
          },
        ],
        seenQueries,
      }),
    });

    const events = await collect(adapter.read('/tmp/opencode.db'));

    expect(events).toHaveLength(1);
    expect(seenQueries.some((query) => query.includes('$.role') && query.includes('$.type'))).toBe(
      true,
    );
  });

  it('falls back to non-json_extract query shape and filters assistant role in JS', async () => {
    const seenQueries: string[] = [];
    const adapter = new OpenCodeSourceAdapter({
      pathReadable: async () => true,
      loadSqliteModule: createSqliteLoader({
        primaryQueryErrors: [new Error('no such function: json_extract')],
        fallbackRows: [
          {
            row_id: 'msg-1',
            row_session_id: 'session-1',
            row_time: 1_737_000_000_000,
            data_json: JSON.stringify({
              role: 'assistant',
              provider: 'anthropic',
              model: 'claude-sonnet-4.5',
              tokens: { input: 10, output: 20 },
            }),
          },
          {
            row_id: 'msg-2',
            row_session_id: 'session-2',
            row_time: 1_737_000_001_000,
            data_json: JSON.stringify({
              role: 'user',
              tokens: { input: 999, output: 999 },
            }),
          },
        ],
        seenQueries,
      }),
    });

    const events = await collect(adapter.read('/tmp/opencode.db'));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4.5',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    expect(seenQueries.some((query) => query.includes('json_extract'))).toBe(true);
    expect(
      seenQueries.some(
        (query) => query.includes('FROM "message"') && !query.includes('WHERE json_extract'),
      ),
    ).toBe(true);
  });

  it('throws actionable schema-drift error when message table is unavailable', async () => {
    const adapter = new OpenCodeSourceAdapter({
      pathReadable: async () => true,
      loadSqliteModule: createSqliteLoader({
        tables: ['session', 'part'],
      }),
    });

    await expect(collect(adapter.read('/tmp/opencode.db'))).rejects.toThrow(
      'OpenCode schema drift: no "message" table (V1) or "session_message" and "session_v2" tables (V2) found.',
    );
  });

  it('throws actionable schema-drift error when message.data column is unavailable', async () => {
    const adapter = new OpenCodeSourceAdapter({
      pathReadable: async () => true,
      loadSqliteModule: createSqliteLoader({
        messageColumns: ['id', 'time_created', 'session_id'],
      }),
    });

    await expect(collect(adapter.read('/tmp/opencode.db'))).rejects.toThrow(
      'OpenCode schema drift: "message.data" column not found.',
    );
  });

  it('throws actionable schema-drift error when message id/timestamp columns are unavailable', async () => {
    const adapter = new OpenCodeSourceAdapter({
      pathReadable: async () => true,
      loadSqliteModule: createSqliteLoader({
        messageColumns: ['session_id', 'data'],
      }),
    });

    await expect(collect(adapter.read('/tmp/opencode.db'))).rejects.toThrow(
      'OpenCode schema drift: required message id/timestamp columns are unavailable.',
    );
  });

  it('uses NULL session alias in primary/fallback queries when session column is missing', async () => {
    const seenQueries: string[] = [];
    const adapter = new OpenCodeSourceAdapter({
      pathReadable: async () => true,
      loadSqliteModule: createSqliteLoader({
        messageColumns: ['id', 'time_created', 'data'],
        primaryQueryErrors: [new Error('no such function: json_extract')],
        fallbackRows: [
          {
            row_id: 'msg-1',
            row_time: 1_737_000_000_000,
            data_json: JSON.stringify({
              role: 'assistant',
              sessionID: 'session-from-payload',
              modelID: 'gpt-4.1',
              tokens: { input: 1, output: 1, total: 2 },
            }),
          },
        ],
        seenQueries,
      }),
    });

    const events = await collect(adapter.read('/tmp/opencode.db'));

    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBe('session-from-payload');
    expect(
      seenQueries.some(
        (query) => query.includes('NULL AS row_session_id') && query.includes('FROM'),
      ),
    ).toBe(true);
  });

  it('falls back to row id for session id and skips rows where every session id source is blank', async () => {
    const adapter = new OpenCodeSourceAdapter({
      pathReadable: async () => true,
      loadSqliteModule: createSqliteLoader({
        primaryRows: [
          {
            row_id: 'msg-fallback-id',
            row_time: 1_737_000_000_000,
            data_json: JSON.stringify({
              role: 'assistant',
              modelID: 'gpt-4.1',
              tokens: { input: 2, output: 3, total: 5 },
            }),
          },
          {
            row_id: '',
            row_time: 1_737_000_001_000,
            data_json: JSON.stringify({
              role: 'assistant',
              modelID: 'gpt-4.1',
              tokens: { input: 1, output: 1, total: 2 },
            }),
          },
        ],
      }),
    });

    const parseDiagnostics = await collectFile(adapter, '/tmp/opencode.db');

    expect(parseDiagnostics.events).toHaveLength(1);
    expect(parseDiagnostics.events[0]?.sessionId).toBe('msg-fallback-id');
    expect(parseDiagnostics.skippedRows).toBe(1);
    expect(parseDiagnostics.skippedRowReasons).toEqual([
      { reason: 'missing_session_id', count: 1 },
    ]);
  });

  it('retries busy/locked errors and succeeds when lock clears within retry budget', async () => {
    const sleepSpy = vi.fn(async () => undefined);
    const adapter = new OpenCodeSourceAdapter({
      pathReadable: async () => true,
      maxBusyRetries: 2,
      busyRetryDelayMs: 5,
      sleep: sleepSpy,
      loadSqliteModule: createSqliteLoader({
        primaryQueryErrors: [createBusyError()],
        primaryRows: [
          {
            row_id: 'msg-1',
            row_session_id: 'session-1',
            row_time: 1_737_000_000_000,
            data_json: JSON.stringify({
              role: 'assistant',
              providerID: 'openai',
              modelID: 'gpt-4.1',
              tokens: { input: 1, output: 2 },
            }),
          },
        ],
      }),
    });

    const events = await collect(adapter.read('/tmp/opencode.db'));

    expect(events).toHaveLength(1);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(5);
  });

  it('uses default sleep implementation between retries when no custom sleep is provided', async () => {
    const adapter = new OpenCodeSourceAdapter({
      pathReadable: async () => true,
      maxBusyRetries: 1,
      busyRetryDelayMs: 1,
      loadSqliteModule: createSqliteLoader({
        primaryQueryErrors: [createBusyError()],
        primaryRows: [
          {
            row_id: 'msg-1',
            row_session_id: 'session-1',
            row_time: 1_737_000_000_000,
            data_json: JSON.stringify({
              role: 'assistant',
              providerID: 'openai',
              modelID: 'gpt-4.1',
              tokens: { input: 2, output: 3 },
            }),
          },
        ],
      }),
    });

    const events = await collect(adapter.read('/tmp/opencode.db'));
    expect(events).toHaveLength(1);
  });

  it('fails with actionable guidance when busy/locked retries are exhausted', async () => {
    const adapter = new OpenCodeSourceAdapter({
      pathReadable: async () => true,
      maxBusyRetries: 2,
      busyRetryDelayMs: 5,
      sleep: async () => undefined,
      loadSqliteModule: createSqliteLoader({
        primaryQueryErrors: [createBusyError(), createBusyError(), createBusyError()],
      }),
    });

    await expect(collect(adapter.read('/tmp/opencode.db'))).rejects.toThrow(
      'OpenCode DB is busy/locked: /tmp/opencode.db. Retries exhausted after 3 attempts.',
    );
  });

  describe('busy retry boundary (open, prepare and the first row)', () => {
    const dbPath = '/tmp/opencode.db';
    const assistantRow = (id: string): Record<string, unknown> => ({
      row_id: id,
      row_session_id: 'session-1',
      row_time: 1_737_000_000_000,
      data_json: JSON.stringify({ role: 'assistant', tokens: { input: 1, output: 2 } }),
    });
    const busyMessage = (attempts: number): string =>
      `OpenCode DB is busy/locked: ${dbPath}. Retries exhausted after ${attempts === 1 ? '1 attempt' : `${attempts} attempts`}. Close active OpenCode processes and retry.`;
    const ioError = (): Error =>
      Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    const ioMessage = `Could not read OpenCode DB at ${dbPath}: SQLITE_IOERR: disk I/O error`;

    async function readUntilError(
      scenario: FakeSqliteScenario,
      calls: string[],
    ): Promise<{ eventIds: string[]; error: Error; skippedRows: number }> {
      const adapter = new OpenCodeSourceAdapter({
        pathReadable: async () => true,
        maxBusyRetries: 2,
        busyRetryDelayMs: 5,
        sleep: async (delayMs) => {
          calls.push(`sleep ${delayMs}`);
        },
        loadSqliteModule: createSqliteLoader({ ...scenario, calls }),
      });
      const diagnostics = { skippedRows: 0, skippedRowReasons: new Map<string, number>() };
      const eventIds: string[] = [];

      try {
        for await (const event of adapter.read(dbPath, { diagnostics })) {
          eventIds.push(event.sessionId);
        }
      } catch (error) {
        return { eventIds, error: error as Error, skippedRows: diagnostics.skippedRows };
      }

      throw new Error('expected the read to fail');
    }

    it('retries a busy first row, closing each failed attempt before waiting', async () => {
      const calls: string[] = [];
      const adapter = new OpenCodeSourceAdapter({
        pathReadable: async () => true,
        maxBusyRetries: 2,
        busyRetryDelayMs: 5,
        sleep: async (delayMs) => {
          calls.push(`sleep ${delayMs}`);
        },
        loadSqliteModule: createSqliteLoader({
          primaryRows: [assistantRow('msg-1'), assistantRow('msg-2')],
          primaryRowErrors: [
            { afterRows: 0, error: createBusyError() },
            { afterRows: 0, error: createBusyError() },
            undefined,
          ],
          calls,
        }),
      });

      await expect(collect(adapter.read(dbPath))).resolves.toHaveLength(2);
      expect(calls).toEqual([
        'open',
        'close',
        'sleep 5',
        'open',
        'close',
        'sleep 10',
        'open',
        'close',
      ]);
    });

    it('rewrites a busy first row that exhausts the retries', async () => {
      const calls: string[] = [];
      const busyError = createBusyError();
      const result = await readUntilError(
        {
          primaryRows: [assistantRow('msg-1')],
          primaryRowErrors: [
            { afterRows: 0, error: createBusyError() },
            { afterRows: 0, error: createBusyError() },
            { afterRows: 0, error: busyError },
          ],
        },
        calls,
      );

      expect(result.error.message).toBe(busyMessage(3));
      expect(result.error.cause).toBe(busyError);
      expect(result.eventIds).toEqual([]);
      expect(calls.filter((call) => call === 'close')).toHaveLength(3);
    });

    it('rewrites a non-busy first row without retrying', async () => {
      const calls: string[] = [];
      const rowError = ioError();
      const result = await readUntilError(
        {
          primaryRows: [assistantRow('msg-1')],
          primaryRowErrors: [{ afterRows: 0, error: rowError }],
        },
        calls,
      );

      expect(result.error.message).toBe(ioMessage);
      expect(result.error.cause).toBe(rowError);
      expect(calls).toEqual(['open', 'close']);
    });

    it('does not retry a busy row after the first, counting the attempts the open took', async () => {
      const firstTry = await readUntilError(
        {
          primaryRows: [assistantRow('msg-1'), assistantRow('msg-2'), assistantRow('msg-3')],
          primaryRowErrors: [{ afterRows: 2, error: createBusyError() }],
        },
        [],
      );

      expect(firstTry.error.message).toBe(busyMessage(1));
      expect(firstTry.eventIds).toEqual(['session-1', 'session-1']);

      const calls: string[] = [];
      const busyError = createBusyError();
      const secondTry = await readUntilError(
        {
          primaryQueryErrors: [createBusyError()],
          primaryRows: [assistantRow('msg-1'), { row_id: 'msg-2', data_json: '' }],
          primaryRowErrors: [{ afterRows: 2, error: busyError }],
        },
        calls,
      );

      expect(secondTry.error.message).toBe(busyMessage(2));
      expect(secondTry.error.cause).toBe(busyError);
      expect(secondTry.eventIds).toEqual(['session-1']);
      expect(secondTry.skippedRows).toBe(1);
      expect(calls).toEqual(['open', 'close', 'sleep 5', 'open', 'close']);
    });

    it('rewrites a non-busy row after the first without retrying', async () => {
      const calls: string[] = [];
      const rowError = ioError();
      const result = await readUntilError(
        {
          primaryRows: [assistantRow('msg-1'), assistantRow('msg-2')],
          primaryRowErrors: [{ afterRows: 1, error: rowError }],
        },
        calls,
      );

      expect(result.error.message).toBe(ioMessage);
      expect(result.error.cause).toBe(rowError);
      expect(result.eventIds).toEqual(['session-1']);
      expect(calls).toEqual(['open', 'close']);
    });
  });

  it.runIf(loadDatabaseSync() && canCountOpenFds)(
    'closes the database and frees it for a writer when the consumer stops early',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-early-return-'));
      tempDirs.push(root);
      const dbPath = path.join(root, 'opencode.db');
      const rowCount = 3;
      const database = new (requireDatabaseSync())(dbPath);

      try {
        database.exec(
          'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)',
        );
        const insert = database.prepare(
          'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
        );

        for (let index = 0; index < rowCount; index += 1) {
          insert.run(
            `msg-${index}`,
            'session-early',
            1_737_000_000_000 + index,
            JSON.stringify({ role: 'assistant', tokens: { input: 10, output: 5 } }),
          );
        }
      } finally {
        database.close();
      }

      expect(readJournalMode(dbPath)).toBe('delete');
      const adapter = new OpenCodeSourceAdapter({ dbPath });
      const before = countOpenFds();

      for await (const event of adapter.read(dbPath)) {
        expect(event.sessionId).toBe('session-early');
        break;
      }

      await waitForOpenFdCount(before);
      expect(canBeginExclusive(dbPath)).toBe(true);
      await expect(collect(adapter.read(dbPath))).resolves.toHaveLength(rowCount);
    },
  );
});
