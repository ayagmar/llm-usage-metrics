import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSessionData } from '../../src/cli/build-session-data.js';
import type { SessionCommandOptions } from '../../src/cli/usage-data-contracts.js';
import type { SessionRow } from '../../src/session/session-row.js';
import { withSuppressedSqliteExperimentalWarning } from '../../src/sources/opencode/sqlite-warning-suppression.js';
import { createAntigravityFixtureDb } from '../helpers/antigravity-fixtures.js';
import { StaticPricingSource } from '../helpers/static-pricing-source.js';

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
  'pi,codex,gemini,droid,opencode,openclaw,claude,copilot,goose,amp,qwen,kimi,cline,roocode,kilocode,antigravity';

const expectedSessionKeys = [
  'amp:amp-e2e-thread',
  'antigravity:conversation',
  'claude:claude-e2e-session',
  'cline:task-cline',
  'codex:codex-e2e-session',
  'copilot:copilot-e2e-session',
  'droid:session-001',
  'droid:session-002',
  'gemini:gemini-e2e-session',
  'goose:goose-e2e-session',
  'kilocode:task-kilocode',
  'kimi:session-kimi',
  'openclaw:openclaw-e2e',
  'opencode:opencode-e2e-session',
  'pi:pi-e2e-session',
  'qwen:qwen-e2e-session',
  'roocode:task-roocode',
] as const;

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

function createE2ePricingSource(): StaticPricingSource {
  const pricedModels = [
    'claude-3-7-sonnet-20250219',
    'claude-amp-e2e',
    'claude-kilocode-e2e',
    'claude-sonnet-4-5',
    'claude-sonnet-4-6',
    'claude-sonnet-cline-e2e',
    'gemini-2.5-pro',
    'gemini-antigravity-e2e',
    'gpt-4.1',
    'gpt-4.1-copilot',
    'gpt-4.1-opencode',
    'gpt-5-codex',
    'gpt-goose-e2e',
    'gpt-roocode-e2e',
    'qwen3-coder-e2e',
  ];

  return new StaticPricingSource({
    pricingByModel: Object.fromEntries(
      pricedModels.map((model) => [
        model,
        {
          inputPer1MUsd: 2,
          outputPer1MUsd: 8,
          cacheReadPer1MUsd: 0.5,
          cacheWritePer1MUsd: 3,
        },
      ]),
    ),
    modelAliases: {
      'gpt-5.2-codex': 'gpt-5-codex',
      'gpt-5.3-codex': 'gpt-5-codex',
    },
  });
}

function toSessionKey(row: SessionRow): string {
  return `${row.source}:${row.sessionId}`;
}

function assertRowsSortedByCostDesc(rows: readonly SessionRow[]): void {
  let previousCost = Number.POSITIVE_INFINITY;
  let sawUnpricedRow = false;

  for (const row of rows) {
    if (row.costUsd === undefined) {
      sawUnpricedRow = true;
      continue;
    }

    expect(sawUnpricedRow).toBe(false);
    expect(row.costUsd).toBeLessThanOrEqual(previousCost);
    previousCost = row.costUsd;
  }
}

const DatabaseSync = loadDatabaseSync();

describe.skipIf(!DatabaseSync)('session report e2e', () => {
  let tempDir: string;
  let opencodeDbPath: string;
  let gooseDbPath: string;
  let antigravityDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-session-e2e-'));
    opencodeDbPath = path.join(tempDir, 'opencode.db');
    gooseDbPath = path.join(tempDir, 'goose.db');
    antigravityDir = path.join(tempDir, 'antigravity');
    await mkdir(antigravityDir);

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

    createAntigravityFixtureDb(path.join(antigravityDir, 'conversation.db'), {
      turns: [
        {
          model: 'gemini-antigravity-e2e',
          timestamp: { seconds: 1_781_510_400 },
          usage: {
            fixedInputTokens: 30,
            inputTokens: 10,
            cacheReadTokens: 5,
            outputTokens: 20,
            reasoningTokens: 5,
            responseId: 'antigravity-e2e-response',
          },
        },
      ],
    });
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  function createAllSourceOptions(): SessionCommandOptions {
    return {
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
      antigravityDir,
      source: allSources,
      timezone: 'UTC',
    };
  }

  it('builds one session row per e2e fixture session sorted by cost descending', async () => {
    const result = await buildSessionData(createAllSourceOptions(), {
      resolvePricingSource: async () => ({
        source: createE2ePricingSource(),
        origin: 'cache',
      }),
    });

    expect(result.rows.map((row) => toSessionKey(row)).sort()).toEqual(expectedSessionKeys);
    assertRowsSortedByCostDesc(result.rows);
    expect(result.rows[0]).toMatchObject({
      source: 'pi',
      sessionId: 'pi-e2e-session',
      costUsd: 0.6,
    });
  });

  it('keeps top sessions after cost ordering', async () => {
    const result = await buildSessionData(
      {
        ...createAllSourceOptions(),
        top: '3',
      },
      {
        resolvePricingSource: async () => ({
          source: createE2ePricingSource(),
          origin: 'cache',
        }),
      },
    );

    expect(result.rows).toHaveLength(3);
    assertRowsSortedByCostDesc(result.rows);
    expect(result.rows.map((row) => toSessionKey(row))).toEqual([
      'pi:pi-e2e-session',
      'kilocode:task-kilocode',
      'roocode:task-roocode',
    ]);
  });
});
