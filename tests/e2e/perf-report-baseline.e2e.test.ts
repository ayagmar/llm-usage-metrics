import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const baselineScriptPath = path.resolve('scripts/perf-report-baseline.mjs');
const scenarioNames = [
  'daily-terminal',
  'daily-markdown',
  'daily-json',
  'weekly-json',
  'monthly-json',
  'efficiency-daily-json',
];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('report performance baseline', () => {
  it('ignores inherited config, cache, and event-store state', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'perf-report-baseline-e2e-'));
    tempDirs.push(tempDir);

    const configPath = path.join(tempDir, 'hostile-config.toml');
    const configStorePath = path.join(tempDir, 'config-events.db');
    const envStorePath = path.join(tempDir, 'env-events.db');
    const hostileGeminiDir = path.join(tempDir, 'hostile-gemini');
    const cacheDir = path.join(tempDir, 'cache');

    await mkdir(hostileGeminiDir);
    await writeFile(
      configPath,
      [
        'sources = ["gemini"]',
        '',
        '[pricing]',
        'offline = true',
        '',
        '[eventStore]',
        'enabled = true',
        `path = "${configStorePath}"`,
        '',
        '[sourceDirs]',
        `gemini = "${hostileGeminiDir}"`,
        '',
      ].join('\n'),
      'utf8',
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', baselineScriptPath],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          LLM_USAGE_CONFIG_PATH: configPath,
          LLM_USAGE_EVENT_STORE: '1',
          LLM_USAGE_EVENT_STORE_PATH: envStorePath,
          XDG_CACHE_HOME: cacheDir,
        },
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );

    for (const scenarioName of scenarioNames) {
      expect(stdout).toContain(scenarioName);
    }
    expect(existsSync(configStorePath)).toBe(false);
    expect(existsSync(envStorePath)).toBe(false);
  }, 30_000);
});
