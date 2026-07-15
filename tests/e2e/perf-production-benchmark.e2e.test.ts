import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildBenchmarkEnv,
  buildLlmBenchmarkEnv,
  ccusageArgs,
  llmArgs,
  rotateForRun,
} from '../../scripts/perf-production-benchmark.mjs';

const benchmarkScriptPath = path.resolve('scripts/perf-production-benchmark.mjs');

describe('production benchmark CLI', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('documents the reproducible default methodology', () => {
    const stdout = execFileSync(process.execPath, [benchmarkScriptPath, '--help'], {
      encoding: 'utf8',
    });

    expect(stdout).toContain('default: 8');
    expect(stdout).toContain('application-cold');
    expect(stdout).toContain('application-warm');
    expect(stdout).toContain('OS filesystem page cache is not flushed');
    expect(stdout).toContain('without npm/npx/pnpm launcher overhead');
  });

  it('sanitizes host overrides and fixes the source roots and timezone', () => {
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', '/host/events.sqlite');
    vi.stubEnv('LLM_USAGE_PARSE_WORKERS', '99');
    vi.stubEnv('CODEX_HOME', '/host/codex');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/host/claude');

    const env = buildBenchmarkEnv({ XDG_CACHE_HOME: '/benchmark/cache' });

    expect(env.LLM_USAGE_EVENT_STORE_PATH).toBeUndefined();
    expect(env.LLM_USAGE_PARSE_WORKERS).toBeUndefined();
    expect(env.CODEX_HOME).toBe(path.join(os.homedir(), '.codex'));
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), '.claude'));
    expect(env.TZ).toBe('UTC');
    expect(env.XDG_CACHE_HOME).toBe('/benchmark/cache');
  });

  it('isolates fresh and warmed llm-usage event-store state', () => {
    const freshEnv = buildLlmBenchmarkEnv({
      cacheRoot: '/benchmark/fresh-cache',
      configRoot: '/benchmark/fresh-config',
    });
    const warmEnv = buildLlmBenchmarkEnv({
      cacheRoot: '/benchmark/warm-cache',
      configRoot: '/benchmark/warm-config',
      eventStorePath: '/benchmark/warm-cache/events.sqlite',
    });

    expect(freshEnv.LLM_USAGE_EVENT_STORE).toBe('0');
    expect(freshEnv.LLM_USAGE_EVENT_STORE_PATH).toBeUndefined();
    expect(warmEnv.LLM_USAGE_EVENT_STORE).toBe('1');
    expect(warmEnv.LLM_USAGE_EVENT_STORE_PATH).toBe('/benchmark/warm-cache/events.sqlite');
  });

  it('uses UTC arguments and rotates every cell through every position', () => {
    expect(ccusageArgs('codex', true)).toEqual([
      'codex',
      'daily',
      '--offline',
      '--timezone',
      'UTC',
      '--json',
    ]);
    expect(llmArgs('codex', false)).toEqual(
      expect.arrayContaining(['--timezone', 'UTC', '--json']),
    );

    const cells = ['ccusageCold', 'ccusageWarm', 'llmCold', 'llmWarm'];
    const orders = [1, 2, 3, 4].map((runIndex) => rotateForRun(cells, runIndex));

    expect(orders.map((order) => order[0])).toEqual(cells);
    expect(orders.every((order) => order.length === cells.length)).toBe(true);
  });
});
