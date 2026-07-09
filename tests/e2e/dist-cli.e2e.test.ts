import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const distCliPath = path.resolve('dist/index.js');
const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');
const largeCodexDir = path.resolve('tests/fixtures/e2e-large/codex');
const geminiDir = path.resolve('tests/fixtures/e2e/gemini');
const droidDir = path.resolve('tests/fixtures/e2e/droid');
const claudeDir = path.resolve('tests/fixtures/e2e/claude');
const openclawDir = path.resolve('tests/fixtures/e2e/openclaw');
const sourceList = 'pi,codex,gemini,droid,openclaw,claude';
const expectedDirectorySourceTokens = 1_200;

type UsageJsonRow = {
  rowType: string;
  periodKey: string;
  totalTokens: number;
};

type ExecFileFailure = Error & {
  code?: number | string;
  stderr?: string;
};

function createSmokeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LLM_USAGE_SKIP_UPDATE_CHECK: '1',
    LLM_USAGE_EVENT_STORE: '0',
  };
}

// Local `pnpm run test` can run before `pnpm run build`; CI's main-test job builds first.
describe.skipIf(!existsSync(distCliPath))('dist CLI e2e', () => {
  it('prints data-only monthly JSON from the built CLI', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        distCliPath,
        'monthly',
        '--json',
        '--timezone',
        'UTC',
        '--source',
        sourceList,
        '--pi-dir',
        piDir,
        '--codex-dir',
        codexDir,
        '--gemini-dir',
        geminiDir,
        '--droid-dir',
        droidDir,
        '--claude-dir',
        claudeDir,
        '--openclaw-dir',
        openclawDir,
      ],
      {
        encoding: 'utf8',
        env: createSmokeEnv(),
        maxBuffer: 1024 * 1024,
      },
    );

    const rows = JSON.parse(stdout) as UsageJsonRow[];
    const grandTotalRow = rows.find(
      (row) => row.rowType === 'grand_total' && row.periodKey === 'ALL',
    );

    expect(grandTotalRow?.totalTokens).toBe(expectedDirectorySourceTokens);
    expect(stderr).toContain('Found');
    expect(stderr).toContain('session file(s)');
  });

  it('prints help even when the user config is malformed', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dist-cli-bad-config-help-'));
    const configPath = path.join(tempDir, 'config.toml');
    await writeFile(configPath, 'not == valid toml', 'utf8');

    try {
      const { stdout } = await execFileAsync(process.execPath, [distCliPath, '--help'], {
        encoding: 'utf8',
        env: { ...createSmokeEnv(), LLM_USAGE_CONFIG_PATH: configPath },
      });

      expect(stdout).toContain('Usage:');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('matches built-binary codex output with worker parsing enabled', async () => {
    const args = [
      distCliPath,
      'daily',
      '--json',
      '--timezone',
      'UTC',
      '--source',
      'codex',
      '--codex-dir',
      largeCodexDir,
      '--pricing-offline',
    ];
    const workersOn = await execFileAsync(process.execPath, args, {
      encoding: 'utf8',
      env: {
        ...createSmokeEnv(),
        LLM_USAGE_PARSE_WORKERS: '2',
        LLM_USAGE_PARSE_WORKER_MIN_BYTES: '1',
      },
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    const workersOff = await execFileAsync(process.execPath, args, {
      encoding: 'utf8',
      env: {
        ...createSmokeEnv(),
        LLM_USAGE_PARSE_WORKERS: '0',
        LLM_USAGE_PARSE_WORKER_MIN_BYTES: '1',
      },
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });

    expect(workersOn.stdout).toBe(workersOff.stdout);
    expect(JSON.parse(workersOn.stdout)).toEqual(JSON.parse(workersOff.stdout));
    expect(workersOn.stderr).toContain('LLM_USAGE_PARSE_WORKERS=2');
    expect(workersOff.stderr).toContain('LLM_USAGE_PARSE_WORKERS=0');
  }, 15_000);

  it('fails a real command with an actionable malformed-config error', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dist-cli-bad-config-run-'));
    const configPath = path.join(tempDir, 'config.toml');
    await writeFile(configPath, 'not == valid toml', 'utf8');

    let exitCode: number | string | undefined;
    let stderr = '';

    try {
      await execFileAsync(process.execPath, [distCliPath, 'monthly', '--pricing-offline'], {
        encoding: 'utf8',
        env: { ...createSmokeEnv(), LLM_USAGE_CONFIG_PATH: configPath },
      });
    } catch (error) {
      exitCode = (error as ExecFileFailure).code;
      stderr = (error as ExecFileFailure).stderr ?? '';
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(exitCode).toBeDefined();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`Failed to parse config file ${configPath}`);
  });

  it('exits nonzero for unknown options', async () => {
    let exitCode: number | string | undefined;

    try {
      await execFileAsync(process.execPath, [distCliPath, 'monthly', '--not-a-flag'], {
        encoding: 'utf8',
        env: createSmokeEnv(),
      });
    } catch (error) {
      exitCode = (error as ExecFileFailure).code;
    }

    expect(exitCode).toBeDefined();
    expect(exitCode).not.toBe(0);
  });
});
