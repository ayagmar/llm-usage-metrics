import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkForUpdates,
  compareVersions,
  getSessionScopedCachePath,
  isCacheFresh,
  isLikelyNpxExecution,
  isLikelySourceExecution,
  resolveLatestVersion,
  shouldOfferUpdate,
  shouldSkipUpdateCheckForArgv,
} from '../../src/update/update-notifier.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

async function createTempCachePath(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return path.join(tempDir, 'update-check.json');
}

describe('update-notifier', () => {
  it('compares semantic versions and applies prerelease policy', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3-alpha.1', '1.2.3-alpha.2')).toBeLessThan(0);

    expect(shouldOfferUpdate('1.2.3', '1.3.0-beta.1')).toBe(false);
    expect(shouldOfferUpdate('1.2.3-beta.1', '1.2.3')).toBe(true);
  });

  it('does not treat blank npm command env as an npx execution signal', () => {
    expect(
      isLikelyNpxExecution(['/usr/bin/node', '/app/dist/index.js'], { npm_command: '   ' }),
    ).toBe(false);
  });

  it('detects argv shapes where update check should be skipped', () => {
    expect(shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js'])).toBe(false);
    expect(shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', '--help'])).toBe(true);
    expect(shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', 'help'])).toBe(true);
    expect(
      shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', 'ts-node/register', 'help']),
    ).toBe(true);
    expect(shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', '--version'])).toBe(true);
    expect(
      shouldSkipUpdateCheckForArgv([
        'node',
        '/app/dist/index.js',
        'custom-bootstrap.js',
        'version',
      ]),
    ).toBe(true);
    expect(
      shouldSkipUpdateCheckForArgv([
        'node',
        '/app/dist/index.js',
        'daily',
        '--provider',
        'version',
      ]),
    ).toBe(false);
    expect(
      shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', 'efficiency', 'daily']),
    ).toBe(false);
    expect(shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', 'efficiency', 'help'])).toBe(
      false,
    );
    expect(shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', 'optimize', 'help'])).toBe(
      false,
    );
  });

  it('uses a fresh cache entry and skips network calls', async () => {
    const cacheFilePath = await createTempCachePath('update-cache-fresh-');
    const nowValue = 1_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 1_000,
        latestVersion: '9.9.9',
      }),
      'utf8',
    );

    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called for fresh cache');
    });

    const latestVersion = await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath,
      cacheTtlMs: 5_000,
      fetchImpl: fetchSpy,
      now: () => nowValue,
    });

    expect(latestVersion).toBe('9.9.9');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isCacheFresh({ checkedAt: nowValue - 1_000 }, 5_000, () => nowValue)).toBe(true);
    expect(isCacheFresh({ checkedAt: nowValue + 100 }, 5_000, () => nowValue)).toBe(false);
  });

  it('ignores malformed cached versions and refreshes from registry', async () => {
    const cacheFilePath = await createTempCachePath('update-cache-invalid-version-');

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: 1_000_000,
        latestVersion: 'not-a-semver',
      }),
      'utf8',
    );

    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ version: '0.9.0' }), { status: 200 }),
    );

    const latestVersion = await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath,
      cacheTtlMs: 5_000,
      fetchImpl: fetchSpy,
      now: () => 1_000_100,
    });

    expect(latestVersion).toBe('0.9.0');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('uses stale cache when network check fails without refreshing checkedAt', async () => {
    const cacheFilePath = await createTempCachePath('update-cache-stale-');
    const nowValue = 1_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 10_000,
        latestVersion: '9.9.9',
      }),
      'utf8',
    );

    const fetchSpy = vi.fn(async () => {
      throw new Error('timeout');
    });

    const latestVersion = await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath,
      cacheTtlMs: 5_000,
      fetchImpl: fetchSpy,
      now: () => nowValue,
      sleep: async () => undefined,
    });

    expect(latestVersion).toBe('9.9.9');
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const updatedCache = JSON.parse(await readFile(cacheFilePath, 'utf8')) as {
      checkedAt: number;
      latestVersion: string;
    };

    expect(updatedCache).toEqual({
      checkedAt: nowValue - 10_000,
      latestVersion: '9.9.9',
    });
  });

  it('uses stale cache when npm registry responds without version payload', async () => {
    const cacheFilePath = await createTempCachePath('update-cache-invalid-response-');
    const nowValue = 2_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 10_000,
        latestVersion: '0.3.0',
      }),
      'utf8',
    );

    const latestVersion = await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath,
      cacheTtlMs: 5_000,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ foo: 'bar' }), { status: 200 })),
      now: () => nowValue,
    });

    expect(latestVersion).toBe('0.3.0');
  });

  it('supports session-scoped update cache files', async () => {
    const cacheFilePath = await createTempCachePath('update-cache-session-');
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
    );

    const baseNow = 5_000_000;
    const now = () => baseNow;
    const sessionEnv = {
      LLM_USAGE_UPDATE_CACHE_SCOPE: 'session',
      LLM_USAGE_UPDATE_CACHE_SESSION_KEY: 'kitty/tab-1',
    };
    const scopedCachePath = getSessionScopedCachePath(cacheFilePath, sessionEnv);

    await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath: scopedCachePath,
      now,
      fetchImpl: fetchSpy,
    });

    await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath: scopedCachePath,
      now,
      fetchImpl: fetchSpy,
    });

    const sessionCachePayload = JSON.parse(await readFile(scopedCachePath, 'utf8')) as {
      checkedAt: number;
      latestVersion: string;
    };

    expect(sessionCachePayload).toEqual({
      checkedAt: baseNow,
      latestVersion: '0.2.0',
    });
    await expect(readFile(cacheFilePath, 'utf8')).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('falls back to parent pid session key when custom env session key is blank', async () => {
    const cacheFilePath = await createTempCachePath('update-cache-session-blank-key-');
    const nowValue = 6_000_000;
    const scopedCachePath = getSessionScopedCachePath(cacheFilePath, {
      LLM_USAGE_UPDATE_CACHE_SCOPE: 'session',
      LLM_USAGE_UPDATE_CACHE_SESSION_KEY: '   ',
    });

    await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath: scopedCachePath,
      now: () => nowValue,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
      ),
    });

    const sessionCachePayload = JSON.parse(await readFile(scopedCachePath, 'utf8')) as {
      checkedAt: number;
      latestVersion: string;
    };

    expect(sessionCachePayload).toEqual({
      checkedAt: nowValue,
      latestVersion: '0.2.0',
    });
    await expect(readFile(cacheFilePath, 'utf8')).rejects.toThrow();
  });

  it('skips update checks for npx execution', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called for npx execution');
    });

    const result = await checkForUpdates({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      argv: ['/usr/bin/node', '/tmp/_npx/123/node_modules/llm-usage/dist/index.js', 'daily'],
      env: {},
      fetchImpl: fetchSpy,
    });

    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('detects npx execution from npm_execpath hints', () => {
    expect(
      isLikelyNpxExecution(['/usr/bin/node', '/app/dist/index.js', 'daily'], {
        npm_execpath: '/usr/lib/node_modules/npm/bin/npx-cli.js',
      }),
    ).toBe(true);

    expect(
      isLikelyNpxExecution(['/usr/bin/node', '/app/dist/index.js', 'daily'], {
        npm_execpath: '/usr/lib/node_modules/pnpm/bin/pnpm.js',
      }),
    ).toBe(false);
    expect(
      isLikelyNpxExecution(['/usr/bin/node', '/app/dist/index.js', 'daily'], {
        npm_command: 'npx',
      }),
    ).toBe(true);
  });

  it('detects local source execution entrypoints', () => {
    expect(isLikelySourceExecution(['/usr/bin/pnpm', '/app/src/cli/index.ts', 'daily'])).toBe(true);
    expect(isLikelySourceExecution(['/usr/bin/node', '/app/src/cli/index.mts', 'daily'])).toBe(
      true,
    );
    expect(isLikelySourceExecution(['/usr/bin/node', '/app/dist/index.js', 'daily'])).toBe(false);
  });

  it('skips update checks for local source execution', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called for local source execution');
    });

    const result = await checkForUpdates({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.11',
      argv: ['/usr/bin/pnpm', '/app/src/cli/index.ts', 'monthly'],
      env: {},
      fetchImpl: fetchSpy,
    });

    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips update checks for help/version invocations', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called when check is skipped');
    });

    const result = await checkForUpdates({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      argv: ['/usr/bin/node', '/app/dist/index.js', '--help'],
      fetchImpl: fetchSpy,
    });

    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips update checks when skip env var is set', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called when env skip flag is set');
    });

    const result = await checkForUpdates({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      env: {
        LLM_USAGE_SKIP_UPDATE_CHECK: '1',
      },
      fetchImpl: fetchSpy,
    });

    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips update checks when skip env var uses truthy string values', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called when env skip flag is set');
    });

    const result = await checkForUpdates({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      env: {
        LLM_USAGE_SKIP_UPDATE_CHECK: 'true',
      },
      fetchImpl: fetchSpy,
    });

    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns undefined when the latest version is not newer', async () => {
    const cacheFilePath = await createTempCachePath('update-non-newer-');

    const result = await checkForUpdates({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.2.0',
      cacheFilePath,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
      ),
      env: {},
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily'],
    });

    expect(result).toBeUndefined();
  });

  it('returns the hint from a fresh cached update without fetching', async () => {
    const cacheFilePath = await createTempCachePath('update-fresh-cache-hit-');
    const nowValue = 7_000_000;
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called for fresh cache');
    });

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 500,
        latestVersion: '0.2.0',
      }),
      'utf8',
    );

    const result = await checkForUpdates({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      cacheTtlMs: 5_000,
      now: () => nowValue,
      fetchImpl: fetchSpy,
      env: { PATH: '/usr/bin' },
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily'],
    });

    expect(result).toBe(
      'Update available for llm-usage-metrics: 0.1.0 → 0.2.0. Run "npm install -g llm-usage-metrics@latest" to update.',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the hint from a missing cache by fetching the latest version', async () => {
    const cacheFilePath = await createTempCachePath('update-missing-cache-fetch-');
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
    );

    const result = await checkForUpdates({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      fetchImpl: fetchSpy,
      env: { PATH: '/usr/bin' },
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily', '--json'],
    });

    expect(result).toBe(
      'Update available for llm-usage-metrics: 0.1.0 → 0.2.0. Run "npm install -g llm-usage-metrics@latest" to update.',
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns the hint from a stale cache by refreshing the latest version', async () => {
    const cacheFilePath = await createTempCachePath('update-stale-refresh-');
    const nowValue = 8_000_000;
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ version: '0.3.0' }), { status: 200 }),
    );

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 10_000,
        latestVersion: '0.2.0',
      }),
      'utf8',
    );

    const result = await checkForUpdates({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      cacheTtlMs: 1_000,
      now: () => nowValue,
      fetchImpl: fetchSpy,
      env: { PATH: '/usr/bin' },
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily'],
    });

    expect(result).toBe(
      'Update available for llm-usage-metrics: 0.1.0 → 0.3.0. Run "npm install -g llm-usage-metrics@latest" to update.',
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns undefined when fresh cached version does not offer an update', async () => {
    const cacheFilePath = await createTempCachePath('update-fresh-no-offer-');

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: 1_000,
        latestVersion: '0.1.0',
      }),
      'utf8',
    );

    const result = await checkForUpdates({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      cacheTtlMs: 5_000,
      now: () => 2_000,
      env: { PATH: '/usr/bin' },
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily'],
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when the version resolve fails and no cache exists', async () => {
    const cacheFilePath = await createTempCachePath('update-resolve-failure-');
    const fetchSpy = vi.fn(async () => {
      throw new Error('registry down');
    });

    const result = await checkForUpdates({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      fetchImpl: fetchSpy,
      env: { PATH: '/usr/bin' },
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily'],
    });

    expect(result).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('swallows unexpected notifier errors and returns undefined', async () => {
    const result = await checkForUpdates({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      now: () => {
        throw new Error('clock unavailable');
      },
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
      ),
      env: {},
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily'],
    });

    expect(result).toBeUndefined();
  });
});
