import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as shareArtifact from '../../src/cli/share-artifact.js';

import { buildEfficiencyReport, runEfficiencyReport } from '../../src/cli/run-efficiency-report.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function overrideStdoutProperty<Key extends 'isTTY' | 'columns'>(
  property: Key,
  value: NodeJS.WriteStream[Key],
): () => void {
  const stdout = process.stdout as NodeJS.WriteStream;
  const previousDescriptor = Object.getOwnPropertyDescriptor(stdout, property);

  Object.defineProperty(stdout, property, {
    configurable: true,
    value,
  });

  return () => {
    if (previousDescriptor) {
      Object.defineProperty(stdout, property, previousDescriptor);
      return;
    }

    Reflect.deleteProperty(stdout, property);
  };
}

function overrideStdoutTty(columns: number): () => void {
  const restoreIsTTY = overrideStdoutProperty('isTTY', true);
  const restoreColumns = overrideStdoutProperty('columns', columns);

  return () => {
    restoreColumns();
    restoreIsTTY();
  };
}

async function runGit(repoDir: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFileAsync('git', ['-C', repoDir, ...args], {
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function createGitRepoWithCommit(commitIsoTimestamp: string): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'efficiency-repo-'));
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

beforeEach(() => {
  vi.spyOn(shareArtifact, 'openShareSvgFile').mockResolvedValue(undefined);
});

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;

  vi.restoreAllMocks();
});

describe('buildEfficiencyReport', () => {
  it('builds json report with git outcomes', async () => {
    const repoDir = await createGitRepoWithCommit('2026-02-14T10:00:00Z');
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'efficiency-empty-sessions-'));
    tempDirs.push(emptyDir);

    const report = await buildEfficiencyReport('daily', {
      piDir: emptyDir,
      codexDir: emptyDir,
      source: 'pi,codex',
      timezone: 'UTC',
      since: '2026-02-14',
      until: '2026-02-14',
      repoDir,
      json: true,
    });

    const parsed = JSON.parse(report) as Array<Record<string, unknown>>;
    const grandTotal = parsed.at(-1);

    // No usage events are parsed from empty dirs, so efficiency rows are omitted
    // and the grand total remains at zero despite the git commit in the fixture repo.
    expect(grandTotal).toMatchObject({
      rowType: 'grand_total',
      periodKey: 'ALL',
      totalTokens: 0,
      costUsd: 0,
      commitCount: 0,
    });
  });

  it('rejects mutually exclusive output flags', async () => {
    await expect(
      buildEfficiencyReport('daily', {
        markdown: true,
        json: true,
      }),
    ).rejects.toThrow('Choose either --markdown or --json, not both');
  });

  it('builds markdown report when --markdown is enabled', async () => {
    const repoDir = await createGitRepoWithCommit('2026-02-14T10:00:00Z');
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'efficiency-markdown-sessions-'));
    tempDirs.push(emptyDir);

    const report = await buildEfficiencyReport('monthly', {
      piDir: emptyDir,
      codexDir: emptyDir,
      source: 'pi,codex',
      timezone: 'UTC',
      since: '2026-02-14',
      until: '2026-02-14',
      repoDir,
      markdown: true,
    });

    expect(report).toContain('| Period');
    expect(report).toContain('| ALL');
  });
});

describe('runEfficiencyReport', () => {
  it('prints report output to stdout', async () => {
    const repoDir = await createGitRepoWithCommit('2026-02-14T10:00:00Z');
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'efficiency-run-empty-sessions-'));
    tempDirs.push(emptyDir);

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runEfficiencyReport('daily', {
      piDir: emptyDir,
      codexDir: emptyDir,
      source: 'pi,codex',
      timezone: 'UTC',
      since: '2026-02-14',
      until: '2026-02-14',
      repoDir,
    });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleLogSpy.mock.calls[0]?.[0])).toContain('Daily Efficiency Report');
  });

  it('warns when terminal table width exceeds available columns', async () => {
    const repoDir = await createGitRepoWithCommit('2026-02-14T10:00:00Z');
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'efficiency-overflow-sessions-'));
    tempDirs.push(emptyDir);

    const restoreStdout = overrideStdoutTty(40);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runEfficiencyReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: 'pi,codex',
        timezone: 'UTC',
        since: '2026-02-14',
        until: '2026-02-14',
        repoDir,
      });
    } finally {
      restoreStdout();
    }

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
    expect(stderrLines.some((line) => line.includes('Report table is wider than terminal'))).toBe(
      true,
    );
  });

  it('does not warn about overflow when terminal is wide enough', async () => {
    const repoDir = await createGitRepoWithCommit('2026-02-14T10:00:00Z');
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'efficiency-wide-sessions-'));
    tempDirs.push(emptyDir);

    const restoreStdout = overrideStdoutTty(500);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runEfficiencyReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: 'pi,codex',
        timezone: 'UTC',
        since: '2026-02-14',
        until: '2026-02-14',
        repoDir,
      });
    } finally {
      restoreStdout();
    }

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
    expect(stderrLines.some((line) => line.includes('Report table is wider than terminal'))).toBe(
      false,
    );
  });

  it('emits active environment overrides to stderr diagnostics', async () => {
    const repoDir = await createGitRepoWithCommit('2026-02-14T10:00:00Z');
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'efficiency-env-overrides-sessions-'));
    tempDirs.push(emptyDir);

    const previousEnvValue = process.env.LLM_USAGE_PARSE_MAX_PARALLEL;
    process.env.LLM_USAGE_PARSE_MAX_PARALLEL = '8';

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runEfficiencyReport('daily', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: 'pi,codex',
        timezone: 'UTC',
        since: '2026-02-14',
        until: '2026-02-14',
        repoDir,
      });
    } finally {
      if (previousEnvValue === undefined) {
        delete process.env.LLM_USAGE_PARSE_MAX_PARALLEL;
      } else {
        process.env.LLM_USAGE_PARSE_MAX_PARALLEL = previousEnvValue;
      }
    }

    expect(String(consoleLogSpy.mock.calls[0]?.[0])).not.toContain('Active environment overrides:');
    const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));
    expect(stderrLines.some((line) => line.includes('Active environment overrides:'))).toBe(true);
    expect(stderrLines.some((line) => line.includes('LLM_USAGE_PARSE_MAX_PARALLEL=8'))).toBe(true);
  });

  it('writes monthly efficiency share svg when --share is enabled', async () => {
    const repoDir = await createGitRepoWithCommit('2026-02-14T10:00:00Z');
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'efficiency-share-empty-sessions-'));
    const shareDir = await mkdtemp(path.join(os.tmpdir(), 'efficiency-share-output-'));
    tempDirs.push(emptyDir, shareDir);

    const previousCwd = process.cwd();
    process.chdir(shareDir);

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runEfficiencyReport('monthly', {
        piDir: emptyDir,
        codexDir: emptyDir,
        source: 'pi,codex',
        timezone: 'UTC',
        since: '2026-02-14',
        until: '2026-02-14',
        repoDir,
        share: true,
      });
    } finally {
      process.chdir(previousCwd);
    }

    const svgPath = path.join(shareDir, 'efficiency-monthly-share.svg');
    const svgContent = await readFile(svgPath, 'utf8');
    const stderrLines = consoleErrorSpy.mock.calls.map((call) => String(call[0]));

    expect(svgContent).toContain('<svg');
    expect(svgContent).toContain('Monthly Efficiency');
    expect(stderrLines.some((line) => line.includes('Wrote efficiency share SVG'))).toBe(true);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects --share for non-monthly efficiency reports', async () => {
    await expect(
      buildEfficiencyReport('weekly', {
        share: true,
      }),
    ).rejects.toThrow('--share is only supported for efficiency monthly');
  });
});
