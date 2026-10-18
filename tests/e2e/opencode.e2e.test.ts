import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUsageReport, runUsageReport } from '../../src/cli/run-usage-report.js';
import {
  createOpenCodeFixtureDb as createSharedOpenCodeFixtureDb,
  createOpenCodeV2FixtureDb,
  E2E_OPENCODE_V2_MESSAGES,
  E2E_OPENCODE_V2_SESSIONS,
} from '../helpers/opencode-fixtures.js';
import { withSuppressedSqliteExperimentalWarning } from '../helpers/sqlite-fixture-db.js';

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
      all: true,
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

  type GrandTotal = {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    costUsd: number;
  };

  async function readGrandTotal(opencodeDbPath: string): Promise<GrandTotal> {
    const report = await buildUsageReport('daily', {
      all: true,
      source: 'opencode',
      opencodeDb: opencodeDbPath,
      timezone: 'UTC',
      json: true,
    });
    const rows = (JSON.parse(report) as { data: (GrandTotal & { rowType: string })[] }).data;
    const grandTotal = rows.find((row) => row.rowType === 'grand_total');

    if (!grandTotal) {
      throw new Error('usage report has no grand_total row');
    }

    return grandTotal;
  }

  // The two assistant steps of E2E_OPENCODE_V2_MESSAGES; V2 stores output without reasoning.
  const V2_STEPS_TOTAL = {
    inputTokens: 1500,
    outputTokens: 270,
    reasoningTokens: 90,
    cacheReadTokens: 9200,
    totalTokens: 10_970,
  };

  it('reads an OpenCode V2 database, one event per assistant step', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-opencode-v2-e2e-'));
    tempDirs.push(tempDir);
    const opencodeDbPath = path.join(tempDir, 'opencode.db');
    createOpenCodeV2FixtureDb(opencodeDbPath, E2E_OPENCODE_V2_SESSIONS, E2E_OPENCODE_V2_MESSAGES);

    const grandTotal = await readGrandTotal(opencodeDbPath);

    expect(grandTotal).toMatchObject(V2_STEPS_TOTAL);
    expect(grandTotal.costUsd).toBeCloseTo(0.011, 10);
  });

  it('counts a message once in a database migrated in place, which keeps the V1 tables', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-opencode-v2-migrated-'));
    tempDirs.push(tempDir);
    const opencodeDbPath = path.join(tempDir, 'opencode.db');
    const [, migratedStep] = E2E_OPENCODE_V2_MESSAGES;
    createOpenCodeV2FixtureDb(opencodeDbPath, E2E_OPENCODE_V2_SESSIONS, E2E_OPENCODE_V2_MESSAGES);
    createSharedOpenCodeFixtureDb(opencodeDbPath, [
      {
        // The V1 original of a migrated step: same id, V1 payload.
        id: migratedStep.id,
        sessionId: 'opencode-v2-e2e-session',
        timeCreated: migratedStep.timeCreated,
        data: JSON.stringify({
          role: 'assistant',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
          tokens: {
            input: 1200,
            output: 30,
            reasoning: 90,
            cache: { read: 4000, write: 0 },
            total: 5320,
          },
          cost: 0.0063,
        }),
      },
      {
        // Written by a V1 build after the migration: only in `message`.
        id: 'opencode-v1-after-migration',
        sessionId: 'opencode-v1-session',
        timeCreated: Date.parse('2026-06-17T09:00:00.000Z'),
        data: JSON.stringify({
          role: 'assistant',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 15 },
          cost: 0.001,
        }),
      },
    ]);

    const grandTotal = await readGrandTotal(opencodeDbPath);

    expect(grandTotal).toMatchObject({
      inputTokens: V2_STEPS_TOTAL.inputTokens + 10,
      outputTokens: V2_STEPS_TOTAL.outputTokens + 5,
      reasoningTokens: V2_STEPS_TOTAL.reasoningTokens,
      cacheReadTokens: V2_STEPS_TOTAL.cacheReadTokens,
      totalTokens: V2_STEPS_TOTAL.totalTokens + 15,
    });
    expect(grandTotal.costUsd).toBeCloseTo(0.012, 10);
  });

  it('treats unavailable default OpenCode DB as source-unavailable without hard failure', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-opencode-unavailable-'));
    tempDirs.push(tempDir);

    process.env.HOME = tempDir;
    process.env.XDG_DATA_HOME = path.join(tempDir, 'xdg-data');
    process.env.APPDATA = path.join(tempDir, 'appdata');
    process.env.LOCALAPPDATA = path.join(tempDir, 'local-appdata');

    const report = await buildUsageReport('daily', {
      all: true,
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
        all: true,
        source: 'opencode',
        opencodeDb: opencodeDbPath,
        timezone: 'UTC',
      }),
    ).rejects.toThrow(
      'OpenCode schema drift: no "message" table (V1) or "session_message" and "session_v2" tables (V2) found.',
    );
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
        all: true,
        source: 'opencode',
        opencodeDb: opencodeDbPath,
        timezone: 'UTC',
      });

      // The malformed JSON row warns; the assistant row without tokens is routine.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipped 1 unreadable row: opencode 1 (invalid_data_json 1)'),
      );
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
      'Use Node.js 22.16+ or 24+.',
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
