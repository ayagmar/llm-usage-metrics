import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getSessionScopedCachePath,
  readUpdateCheckCachePayload,
  resolveLatestVersion,
  writeUpdateCheckCachePayload,
} from '../../src/update/update-cache-repository.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

describe('update-cache-repository', () => {
  it('returns the base cache path when session scoping is disabled', () => {
    const cacheFilePath = '/tmp/cache/update-check.json';

    expect(getSessionScopedCachePath(cacheFilePath, {})).toBe(cacheFilePath);
    expect(
      getSessionScopedCachePath(cacheFilePath, {
        LLM_USAGE_UPDATE_CACHE_SCOPE: 'global',
      }),
    ).toBe(cacheFilePath);
  });

  it('builds a session-scoped cache path with sanitized session key', () => {
    const cacheFilePath = '/tmp/cache/update-check.json';

    const scopedPath = getSessionScopedCachePath(
      cacheFilePath,
      {
        LLM_USAGE_UPDATE_CACHE_SCOPE: 'session',
        LLM_USAGE_UPDATE_CACHE_SESSION_KEY: 'kitty/tab-1',
      },
      { parentPid: 777 },
    );

    expect(scopedPath).toBe(path.join('/tmp/cache', 'update-check.kitty_tab-1.json'));
  });

  it('falls back to parent pid when session scope key is blank', () => {
    const scopedPath = getSessionScopedCachePath(
      '/tmp/cache/update-check.json',
      {
        LLM_USAGE_UPDATE_CACHE_SCOPE: 'session',
        LLM_USAGE_UPDATE_CACHE_SESSION_KEY: '   ',
      },
      { parentPid: 777 },
    );

    expect(scopedPath).toBe(path.join('/tmp/cache', 'update-check.ppid-777.json'));
  });

  it('falls back to parent pid when session scope key env var is missing', () => {
    const scopedPath = getSessionScopedCachePath(
      '/tmp/cache/update-check.json',
      {
        LLM_USAGE_UPDATE_CACHE_SCOPE: 'SESSION',
      },
      { parentPid: 42 },
    );

    expect(scopedPath).toBe(path.join('/tmp/cache', 'update-check.ppid-42.json'));
  });

  it('writes cache payloads and ignores malformed cache content on read', async () => {
    const tempDir = await createTempDir('update-cache-repository-');
    const cacheFilePath = path.join(tempDir, 'nested', 'update-check.json');

    await writeUpdateCheckCachePayload(cacheFilePath, {
      checkedAt: 1234,
      latestVersion: '1.2.3',
    });

    await expect(readUpdateCheckCachePayload(cacheFilePath)).resolves.toEqual({
      checkedAt: 1234,
      latestVersion: '1.2.3',
    });

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: 1234,
        latestVersion: 'not-a-semver',
      }),
      'utf8',
    );

    await expect(readUpdateCheckCachePayload(cacheFilePath)).resolves.toBeUndefined();
  });

  it('returns undefined for unreadable or invalid cache payload shapes', async () => {
    const tempDir = await createTempDir('update-cache-repository-invalid-');
    const cacheFilePath = path.join(tempDir, 'update-check.json');

    await expect(readUpdateCheckCachePayload(cacheFilePath)).resolves.toBeUndefined();

    await writeFile(cacheFilePath, '{not-json', 'utf8');
    await expect(readUpdateCheckCachePayload(cacheFilePath)).resolves.toBeUndefined();

    await writeFile(cacheFilePath, JSON.stringify(['not', 'an', 'object']), 'utf8');
    await expect(readUpdateCheckCachePayload(cacheFilePath)).resolves.toBeUndefined();

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: -1,
        latestVersion: '1.2.3',
      }),
      'utf8',
    );
    await expect(readUpdateCheckCachePayload(cacheFilePath)).resolves.toBeUndefined();

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: Number.NaN,
        latestVersion: '1.2.3',
      }),
      'utf8',
    );
    await expect(readUpdateCheckCachePayload(cacheFilePath)).resolves.toBeUndefined();

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: 123,
        latestVersion: '   ',
      }),
      'utf8',
    );
    await expect(readUpdateCheckCachePayload(cacheFilePath)).resolves.toBeUndefined();
  });

  it('returns undefined when registry fetch fails and no stale cache is available', async () => {
    const tempDir = await createTempDir('update-cache-repository-fetch-fail-');
    const cacheFilePath = path.join(tempDir, 'update-check.json');

    await expect(
      resolveLatestVersion({
        packageName: 'llm-usage-metrics',
        cacheFilePath,
        fetchImpl: async () => new Response('oops', { status: 503 }),
        sleep: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    await expect(
      resolveLatestVersion({
        packageName: 'llm-usage-metrics',
        cacheFilePath,
        fetchImpl: async () => {
          throw new Error('network down');
        },
        sleep: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined for invalid registry payloads when no stale cache exists', async () => {
    const tempDir = await createTempDir('update-cache-repository-invalid-registry-');
    const cacheFilePath = path.join(tempDir, 'update-check.json');

    await expect(
      resolveLatestVersion({
        packageName: 'llm-usage-metrics',
        cacheFilePath,
        fetchImpl: async () => new Response(JSON.stringify(['not', 'object']), { status: 200 }),
      }),
    ).resolves.toBeUndefined();

    await expect(
      resolveLatestVersion({
        packageName: 'llm-usage-metrics',
        cacheFilePath,
        fetchImpl: async () =>
          new Response(JSON.stringify({ version: 'not-a-semver' }), { status: 200 }),
      }),
    ).resolves.toBeUndefined();
  });

  it('retries transient update fetch failures and returns recovered network version', async () => {
    const tempDir = await createTempDir('update-cache-repository-retries-');
    const cacheFilePath = path.join(tempDir, 'update-check.json');
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '1.9.0' }), { status: 200 }));

    const latestVersion = await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath,
      fetchImpl,
      sleep: async () => undefined,
    });

    expect(latestVersion).toBe('1.9.0');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns stale cache without refreshing checkedAt when fetch fails', async () => {
    const tempDir = await createTempDir('update-cache-repository-stale-no-refresh-');
    const cacheFilePath = path.join(tempDir, 'update-check.json');
    const nowValue = 900_000;

    await writeUpdateCheckCachePayload(cacheFilePath, {
      checkedAt: nowValue - 10_000,
      latestVersion: '1.2.3',
    });

    const latestVersion = await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath,
      cacheTtlMs: 1_000,
      now: () => nowValue,
      fetchImpl: async () => {
        throw new Error('timeout');
      },
      sleep: async () => undefined,
    });

    expect(latestVersion).toBe('1.2.3');
    await expect(readUpdateCheckCachePayload(cacheFilePath)).resolves.toEqual({
      checkedAt: nowValue - 10_000,
      latestVersion: '1.2.3',
    });
  });

  it('allows disabling retries by setting fetchRetryCount to zero', async () => {
    const tempDir = await createTempDir('update-cache-repository-no-retries-');
    const cacheFilePath = path.join(tempDir, 'update-check.json');
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });

    const latestVersion = await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath,
      fetchImpl,
      fetchRetryCount: 0,
      sleep: async () => undefined,
    });

    expect(latestVersion).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns fetched version when cache write fails after a successful fetch', async () => {
    const tempDir = await createTempDir('update-cache-repository-cache-write-fail-');
    const cacheFilePath = path.join(tempDir, 'nested', 'update-check.json');
    const cacheDirPath = path.dirname(cacheFilePath);

    const latestVersion = await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath,
      fetchImpl: async () => {
        await writeFile(cacheDirPath, 'not-a-directory', 'utf8');
        return new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 });
      },
    });

    expect(latestVersion).toBe('2.0.0');
    await expect(readUpdateCheckCachePayload(cacheFilePath)).resolves.toBeUndefined();
  });
});
