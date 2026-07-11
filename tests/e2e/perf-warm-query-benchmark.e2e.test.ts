import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const benchmarkScriptPath = path.resolve('scripts/perf-warm-query-benchmark.mjs');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function readBenchmarkField(stdout: string, key: string): string {
  const line = stdout.split('\n').find((entry) => entry.startsWith(`benchmark: ${key}=`));
  if (!line) {
    throw new Error(`benchmark smoke output missing "${key}": ${stdout}`);
  }
  return line.slice(`benchmark: ${key}=`.length).trim();
}

describe('warm-query benchmark smoke', () => {
  it('overrides a hostile environment and stays hermetic under its temp root', async () => {
    // A canary the benchmark must never touch: a plausible-looking cache home.
    const canaryHome = await mkdtemp(path.join(os.tmpdir(), 'warm-query-canary-home-'));
    const canaryCache = path.join(canaryHome, 'cache');
    await mkdir(canaryCache, { recursive: true });
    tempDirs.push(canaryHome);

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', benchmarkScriptPath, '--smoke'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          // Hostile opposites of what the benchmark must resolve to.
          HOME: canaryHome,
          XDG_CACHE_HOME: canaryCache,
          LLM_USAGE_EVENT_STORE: '0',
          LLM_USAGE_PARSE_WORKERS: '8',
          LLM_USAGE_EVENT_STORE_PATH: path.join(canaryHome, 'hostile-events.db'),
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    );

    // Exit 0 implies every scenario validated (candidates == C1 == oracle).
    expect(stdout).toContain('smoke: all scenarios validated');

    // The benchmark overrode the hostile values: store enabled, under its temp.
    expect(readBenchmarkField(stdout, 'eventStoreEnabled')).toBe('true');
    const tempDir = readBenchmarkField(stdout, 'tempDir');
    const storePath = readBenchmarkField(stdout, 'eventStorePath');
    const cacheRoot = readBenchmarkField(stdout, 'cacheRoot');
    expect(storePath.startsWith(tempDir + path.sep)).toBe(true);
    expect(cacheRoot.startsWith(tempDir + path.sep)).toBe(true);

    // The isolation guard held: the canary cache and hostile store were untouched.
    expect(readdirSync(canaryCache)).toHaveLength(0);
    expect(existsSync(path.join(canaryHome, 'hostile-events.db'))).toBe(false);

    // The benchmark cleaned up its temp directory.
    expect(readBenchmarkField(stdout, 'cleanedUp')).toBe('true');
    expect(existsSync(tempDir)).toBe(false);
  }, 120_000);
});
