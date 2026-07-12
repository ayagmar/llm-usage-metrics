import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUsageReport, runUsageReport } from '../../src/cli/run-usage-report.js';
import { withSuppressedSqliteExperimentalWarning } from '../../src/sources/opencode/sqlite-warning-suppression.js';

type OpenCodeMessageFixture = {
  id: string;
  sessionId: string;
  timeCreated: number;
  data: string;
};

type FixtureDatabaseSync = new (filePath: string) => {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...args: unknown[]) => void };
  close: () => void;
};

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalAppData = process.env.APPDATA;
const originalLocalAppData = process.env.LOCALAPPDATA;

function restoreEnv(): void {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdgDataHome;
  }

  if (originalAppData === undefined) {
    delete process.env.APPDATA;
  } else {
    process.env.APPDATA = originalAppData;
  }

  if (originalLocalAppData === undefined) {
    delete process.env.LOCALAPPDATA;
  } else {
    process.env.LOCALAPPDATA = originalLocalAppData;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
  restoreEnv();
  vi.unstubAllGlobals();
});

function createOpenCodeFixtureDb(dbPath: string, messages: OpenCodeMessageFixture[]): void {
  const DatabaseSync = loadDatabaseSync();
  const database = new DatabaseSync(dbPath);

  try {
    database.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE part (id TEXT PRIMARY KEY);
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

    const insertMessage = database.prepare(
      'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
    );

    for (const message of messages) {
      insertMessage.run(message.id, message.sessionId, message.timeCreated, message.data);
    }
  } finally {
    database.close();
  }
}

describe('opencode e2e', () => {
  it('renders OpenCode-only report from explicit --opencode-db override', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-opencode-e2e-'));
    tempDirs.push(tempDir);

    const opencodeDbPath = path.join(tempDir, 'opencode.db');

    createOpenCodeFixtureDb(opencodeDbPath, [
      {
        id: 'm-1',
        sessionId: 'session-a',
        timeCreated: 1_737_000_000_000,
        data: JSON.stringify({
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-4.1',
          tokens: {
            input: 120,
            output: 80,
            reasoning: 0,
            cache: { read: 10, write: 0 },
            total: 210,
          },
          cost: 0.42,
        }),
      },
    ]);

    const report = await buildUsageReport('daily', {
      source: 'opencode',
      opencodeDb: opencodeDbPath,
      timezone: 'UTC',
      json: true,
    });

    const parsed = JSON.parse(report) as {
      schemaVersion: number;
      report: string;
      data: Array<{
        rowType: string;
        source: string;
        totalTokens: number;
        costUsd: number;
      }>;
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'usage' });
    const rows = parsed.data;

    expect(rows.some((row) => row.rowType === 'period_source' && row.source === 'opencode')).toBe(
      true,
    );
    expect(rows.at(-1)).toMatchObject({
      rowType: 'grand_total',
      source: 'combined',
      totalTokens: 210,
      costUsd: 0.42,
    });
  });

  it('treats unavailable default OpenCode DB as source-unavailable without hard failure', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-opencode-unavailable-'));
    tempDirs.push(tempDir);

    process.env.HOME = tempDir;
    process.env.XDG_DATA_HOME = path.join(tempDir, 'xdg-data');
    process.env.APPDATA = path.join(tempDir, 'appdata');
    process.env.LOCALAPPDATA = path.join(tempDir, 'local-appdata');

    const report = await buildUsageReport('daily', {
      source: 'opencode',
      timezone: 'UTC',
      json: true,
    });

    expect(JSON.parse(report)).toEqual({
      schemaVersion: 1,
      report: 'usage',
      data: [
        {
          rowType: 'grand_total',
          periodKey: 'ALL',
          source: 'combined',
          models: [],
          modelBreakdown: [],
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
      ],
    });
  });

  it('fails explicitly on schema drift when required tables are missing', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-opencode-schema-drift-'));
    tempDirs.push(tempDir);

    const opencodeDbPath = path.join(tempDir, 'opencode-bad.db');
    const DatabaseSync = loadDatabaseSync();
    const database = new DatabaseSync(opencodeDbPath);
    database.exec('CREATE TABLE session (id TEXT PRIMARY KEY);');
    database.close();

    await expect(
      buildUsageReport('daily', {
        source: 'opencode',
        opencodeDb: opencodeDbPath,
        timezone: 'UTC',
      }),
    ).rejects.toThrow('OpenCode schema drift: required "message" table not found.');
  });

  it('emits skipped-row diagnostics in terminal mode for malformed/incomplete rows', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-opencode-skipped-rows-'));
    tempDirs.push(tempDir);

    const opencodeDbPath = path.join(tempDir, 'opencode.db');

    createOpenCodeFixtureDb(opencodeDbPath, [
      {
        id: 'm-1',
        sessionId: 'session-a',
        timeCreated: 1_737_000_000_000,
        data: JSON.stringify({
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-4.1',
          tokens: { input: 10, output: 5, total: 15 },
        }),
      },
      {
        id: 'm-2',
        sessionId: 'session-a',
        timeCreated: 1_737_000_001_000,
        data: '{malformed',
      },
      {
        id: 'm-3',
        sessionId: 'session-a',
        timeCreated: 1_737_000_002_000,
        data: JSON.stringify({ role: 'assistant', modelID: 'gpt-4.1' }),
      },
    ]);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await runUsageReport('daily', {
        source: 'opencode',
        opencodeDb: opencodeDbPath,
        timezone: 'UTC',
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Skipped 2 malformed rows'));
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
const require = createRequire(import.meta.url);

function createNodeSqliteFixtureError(reason: string): Error {
  return new Error(
    [
      'OpenCode e2e fixtures require node:sqlite DatabaseSync support.',
      'Use Node.js 24+.',
      `Runtime load failure: ${reason}`,
    ].join(' '),
  );
}

function loadDatabaseSync(): FixtureDatabaseSync {
  let sqliteModule: unknown;

  try {
    sqliteModule = withSuppressedSqliteExperimentalWarning(() => require('node:sqlite') as unknown);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw createNodeSqliteFixtureError(reason);
  }

  const moduleRecord = sqliteModule as { DatabaseSync?: unknown } | undefined;

  if (typeof moduleRecord?.DatabaseSync !== 'function') {
    throw createNodeSqliteFixtureError(
      'node:sqlite loaded but did not expose a DatabaseSync constructor.',
    );
  }

  return moduleRecord.DatabaseSync as FixtureDatabaseSync;
}
