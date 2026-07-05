import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const distCliPath = path.resolve('dist/index.js');
const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');
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
};

function createSmokeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LLM_USAGE_SKIP_UPDATE_CHECK: '1',
    LLM_USAGE_PARSE_CACHE_ENABLED: '0',
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
