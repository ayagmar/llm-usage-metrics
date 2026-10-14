import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import { createAntigravityFixtureDb } from '../helpers/antigravity-fixtures.js';
import { createDshSessionsFixture } from '../helpers/dsh-fixtures.js';
import { createGooseFixtureDb, E2E_GOOSE_SESSIONS } from '../helpers/goose-fixtures.js';
import { createOpenCodeFixtureDb, E2E_OPENCODE_MESSAGES } from '../helpers/opencode-fixtures.js';
import { loadDatabaseSync } from '../helpers/sqlite-fixture-db.js';

type UsageJsonRow = {
  rowType: string;
  periodKey: string;
  source: string;
  totalTokens: number;
};

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
  'pi,codex,gemini,droid,opencode,openclaw,claude,copilot,goose,amp,qwen,kimi,cline,roocode,kilocode,antigravity,dsh';
const expectedAllSourceTokens = 4_610;
const expectedGeminiClaudeTokens = 415;

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
  let antigravityDir: string;
  let dshDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-multi-source-e2e-'));
    opencodeDbPath = path.join(tempDir, 'opencode.db');
    gooseDbPath = path.join(tempDir, 'goose.db');
    antigravityDir = path.join(tempDir, 'antigravity');
    dshDir = path.join(tempDir, 'dsh');
    await mkdir(antigravityDir);
    await createDshSessionsFixture(dshDir);

    createOpenCodeFixtureDb(opencodeDbPath, E2E_OPENCODE_MESSAGES);
    createGooseFixtureDb(gooseDbPath, E2E_GOOSE_SESSIONS);

    createAntigravityFixtureDb(path.join(antigravityDir, 'conversation.db'), {
      turns: [
        {
          model: 'gemini-antigravity-e2e',
          timestamp: { seconds: 1_781_510_400 },
          usage: {
            modelEnum: 1016,
            inputTokens: 40,
            cacheReadTokens: 5,
            totalOutputTokens: 20,
            outputTokens: 15,
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
      antigravityDir,
      dshDir,
      source: allSources,
      timezone: 'UTC',
      json: true,
    });

    const parsed = JSON.parse(report) as {
      schemaVersion: number;
      report: string;
      data: UsageJsonRow[];
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'usage' });
    const rows = parsed.data;
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
      antigravityDir,
      dshDir,
      source: 'gemini,claude',
      timezone: 'UTC',
      json: true,
    });

    const parsed = JSON.parse(report) as {
      schemaVersion: number;
      report: string;
      data: UsageJsonRow[];
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'usage' });
    const rows = parsed.data;
    const sourceRows = getPeriodSourceRows(rows);
    const sourceIds = [...new Set(sourceRows.map((row) => row.source))].sort();
    const grandTotalRows = getGrandTotalRows(rows);

    expect(sourceIds).toEqual(['claude', 'gemini']);
    expect(grandTotalRows).toHaveLength(1);
    expect(grandTotalRows[0]?.totalTokens).toBe(expectedGeminiClaudeTokens);
  });
});
