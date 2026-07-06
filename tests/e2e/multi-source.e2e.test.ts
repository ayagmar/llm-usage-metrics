import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import { withSuppressedSqliteExperimentalWarning } from '../../src/sources/opencode/sqlite-warning-suppression.js';

type OpenCodeMessageFixture = {
  id: string;
  sessionId: string;
  timeCreated: number;
  data: string;
};

type GooseSessionFixture = {
  id: string;
  modelConfigJson: string;
  providerName: string;
  createdAt: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
};

type FixtureDatabaseSync = new (filePath: string) => {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...args: unknown[]) => void };
  close: () => void;
};

type UsageJsonRow = {
  rowType: string;
  periodKey: string;
  source: string;
  totalTokens: number;
};

const require = createRequire(import.meta.url);
const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');
const geminiDir = path.resolve('tests/fixtures/e2e/gemini');
const droidDir = path.resolve('tests/fixtures/e2e/droid');
const claudeDir = path.resolve('tests/fixtures/e2e/claude');
const openclawDir = path.resolve('tests/fixtures/e2e/openclaw');
const copilotDir = path.resolve('tests/fixtures/e2e/copilot');
const ampDir = path.resolve('tests/fixtures/e2e/amp');
const qwenDir = path.resolve('tests/fixtures/e2e/qwen/projects');
const kimiDir = path.resolve('tests/fixtures/e2e/kimi');
const clineDir = path.resolve('tests/fixtures/e2e/cline');
const roocodeDir = path.resolve('tests/fixtures/e2e/roocode');
const kilocodeDir = path.resolve('tests/fixtures/e2e/kilocode');
const allSources =
  'pi,codex,gemini,droid,opencode,openclaw,claude,copilot,goose,amp,qwen,kimi,cline,roocode,kilocode';
const expectedAllSourceTokens = 2_110;
const expectedGeminiClaudeTokens = 415;

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

function createOpenCodeFixtureDb(dbPath: string, messages: OpenCodeMessageFixture[]): void {
  const DatabaseSync = loadDatabaseSync();

  if (!DatabaseSync) {
    throw new Error('OpenCode e2e fixtures require node:sqlite DatabaseSync support.');
  }

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

function createGooseFixtureDb(dbPath: string, sessions: GooseSessionFixture[]): void {
  const DatabaseSync = loadDatabaseSync();

  if (!DatabaseSync) {
    throw new Error('Goose e2e fixtures require node:sqlite DatabaseSync support.');
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
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
      );
    }
  } finally {
    database.close();
  }
}

function getPeriodSourceRows(rows: UsageJsonRow[]): UsageJsonRow[] {
  return rows.filter((row) => row.rowType === 'period_source');
}

function getGrandTotalRows(rows: UsageJsonRow[]): UsageJsonRow[] {
  return rows.filter((row) => row.rowType === 'grand_total' && row.periodKey === 'ALL');
}

const DatabaseSync = loadDatabaseSync();

describe.skipIf(!DatabaseSync)('multi-source usage report e2e', () => {
  let tempDir: string;
  let opencodeDbPath: string;
  let gooseDbPath: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-multi-source-e2e-'));
    opencodeDbPath = path.join(tempDir, 'opencode.db');
    gooseDbPath = path.join(tempDir, 'goose.db');

    createOpenCodeFixtureDb(opencodeDbPath, [
      {
        id: 'opencode-e2e-message-1',
        sessionId: 'opencode-e2e-session',
        timeCreated: Date.parse('2026-06-15T12:00:00.000Z'),
        data: JSON.stringify({
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-4.1-opencode',
          tokens: {
            input: 90,
            output: 40,
            reasoning: 0,
            cache: { read: 10, write: 0 },
            total: 140,
          },
        }),
      },
      {
        id: 'opencode-e2e-message-2',
        sessionId: 'opencode-e2e-session',
        timeCreated: Date.parse('2026-06-15T12:05:00.000Z'),
        data: JSON.stringify({
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-4.1-opencode',
          tokens: {
            input: 35,
            output: 20,
            reasoning: 0,
            cache: { read: 5, write: 0 },
            total: 60,
          },
        }),
      },
    ]);

    createGooseFixtureDb(gooseDbPath, [
      {
        id: 'goose-e2e-session',
        modelConfigJson: JSON.stringify({ model_name: 'gpt-goose-e2e' }),
        providerName: 'openai',
        createdAt: '2026-06-15T12:15:00.000Z',
        totalTokens: 180,
        inputTokens: 100,
        outputTokens: 50,
      },
    ]);
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('renders a combined monthly report across every source', async () => {
    const report = await buildUsageReport('monthly', {
      piDir,
      codexDir,
      geminiDir,
      droidDir,
      claudeDir,
      opencodeDb: opencodeDbPath,
      openclawDir,
      copilotDir,
      gooseDb: gooseDbPath,
      ampDir,
      qwenDir,
      kimiDir,
      clineDir,
      roocodeDir,
      kilocodeDir,
      source: allSources,
      timezone: 'UTC',
      json: true,
    });

    const rows = JSON.parse(report) as UsageJsonRow[];
    const sourceRows = getPeriodSourceRows(rows);
    const sourceIds = new Set(sourceRows.map((row) => row.source));
    const grandTotalRows = getGrandTotalRows(rows);

    for (const sourceId of allSources.split(',')) {
      expect(sourceIds.has(sourceId)).toBe(true);
    }

    expect(grandTotalRows).toHaveLength(1);
    expect(grandTotalRows[0]).toMatchObject({
      periodKey: 'ALL',
      rowType: 'grand_total',
      totalTokens: expectedAllSourceTokens,
    });
  });

  it('filters the full adapter set down to selected sources', async () => {
    const report = await buildUsageReport('monthly', {
      piDir,
      codexDir,
      geminiDir,
      droidDir,
      claudeDir,
      opencodeDb: opencodeDbPath,
      openclawDir,
      copilotDir,
      gooseDb: gooseDbPath,
      ampDir,
      qwenDir,
      kimiDir,
      clineDir,
      roocodeDir,
      kilocodeDir,
      source: 'gemini,claude',
      timezone: 'UTC',
      json: true,
    });

    const rows = JSON.parse(report) as UsageJsonRow[];
    const sourceRows = getPeriodSourceRows(rows);
    const sourceIds = [...new Set(sourceRows.map((row) => row.source))].sort();
    const grandTotalRows = getGrandTotalRows(rows);

    expect(sourceIds).toEqual(['claude', 'gemini']);
    expect(grandTotalRows).toHaveLength(1);
    expect(grandTotalRows[0]?.totalTokens).toBe(expectedGeminiClaudeTokens);
  });
});
