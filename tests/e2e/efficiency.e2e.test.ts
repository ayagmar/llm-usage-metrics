import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { buildEfficiencyReport } from '../../src/cli/run-efficiency-report.js';

type EfficiencyJsonRow = {
  rowType: 'period' | 'period_source' | 'grand_total';
  periodKey: string;
  source?: string;
  totalTokens: number;
  costUsd?: number;
  commitCount?: number;
  linesAdded?: number;
  linesDeleted?: number;
  linesChanged?: number;
  tokensPerCommit?: number;
};

const execFileAsync = promisify(execFile);
const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');
const geminiDir = path.resolve('tests/fixtures/e2e/gemini');
const droidDir = path.resolve('tests/fixtures/e2e/droid');
const openclawDir = path.resolve('tests/fixtures/e2e/openclaw');
const claudeDir = path.resolve('tests/fixtures/e2e/claude');
const selectedSources = 'pi,codex,gemini,droid,openclaw,claude';
const tempDirs: string[] = [];

async function runGit(repoDir: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync('git', ['-C', repoDir, ...args], {
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function createGitRepoWithCommit(commitIsoTimestamp: string): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'efficiency-e2e-repo-'));
  tempDirs.push(repoDir);

  await runGit(repoDir, ['init']);
  await runGit(repoDir, ['config', 'user.name', 'Test User']);
  await runGit(repoDir, ['config', 'user.email', 'test@example.com']);

  const trackedFilePath = path.join(repoDir, 'tracked.txt');
  await writeFile(trackedFilePath, 'first line\nsecond line\n', 'utf8');

  await runGit(repoDir, ['add', 'tracked.txt']);
  await runGit(repoDir, ['commit', '-m', 'initial commit'], {
    GIT_AUTHOR_DATE: commitIsoTimestamp,
    GIT_COMMITTER_DATE: commitIsoTimestamp,
  });

  return repoDir;
}

async function createAttributedClaudeDir(repoDir: string): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'efficiency-e2e-claude-'));
  const projectDir = path.join(rootDir, 'project');
  const fixturePath = path.join(claudeDir, 'e2e-project', 'session.jsonl');
  const outputPath = path.join(projectDir, 'session.jsonl');
  tempDirs.push(rootDir);

  await mkdir(projectDir, { recursive: true });

  const rewrittenLines = (await readFile(fixturePath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      row.cwd = repoDir;
      return JSON.stringify(row);
    });

  await writeFile(outputPath, `${rewrittenLines.join('\n')}\n`, 'utf8');

  return rootDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('efficiency report e2e', () => {
  it('renders the zero-correlation shape for static fixtures', async () => {
    const report = await buildEfficiencyReport('monthly', {
      source: selectedSources,
      piDir,
      codexDir,
      geminiDir,
      droidDir,
      openclawDir,
      claudeDir,
      since: '2026-01-01',
      until: '2026-06-30',
      timezone: 'UTC',
      pricingOffline: true,
      json: true,
    });
    const parsed = JSON.parse(report) as {
      schemaVersion: number;
      report: string;
      data: { grouping: string; rows: EfficiencyJsonRow[] };
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'efficiency' });
    const rows = parsed.data.rows;

    // Static e2e fixtures use repo roots such as /tmp/claude-e2e that are not git repos.
    // Efficiency JSON is repo-scoped, so unattributed fixture usage is excluded.
    expect(rows).toEqual([
      {
        rowType: 'grand_total',
        periodKey: 'ALL',
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        commitCount: 0,
        linesAdded: 0,
        linesDeleted: 0,
        linesChanged: 0,
      },
    ]);
  });

  it('attributes usage and commits to a temp git repo', async () => {
    const repoDir = await createGitRepoWithCommit('2026-06-20T12:30:00Z');
    const attributedClaudeDir = await createAttributedClaudeDir(repoDir);

    const report = await buildEfficiencyReport('monthly', {
      source: 'claude',
      claudeDir: attributedClaudeDir,
      repoDir,
      since: '2026-06-01',
      until: '2026-06-30',
      timezone: 'UTC',
      pricingOffline: true,
      json: true,
    });
    const parsed = JSON.parse(report) as { data: { rows: EfficiencyJsonRow[] } };
    const rows = parsed.data.rows;
    const periodRow = rows.find((row) => row.rowType === 'period' && row.periodKey === '2026-06');
    const grandTotal = rows.find((row) => row.rowType === 'grand_total');

    expect(periodRow).toMatchObject({
      rowType: 'period',
      periodKey: '2026-06',
      totalTokens: 220,
      commitCount: 1,
      linesAdded: 2,
      linesDeleted: 0,
      linesChanged: 2,
    });
    expect(grandTotal).toMatchObject({
      rowType: 'grand_total',
      periodKey: 'ALL',
      totalTokens: 220,
      commitCount: 1,
    });
    expect(periodRow?.tokensPerCommit).toBe(195);
  });
});
