import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseSelectedAdapters } from '../../src/cli/build-usage-data-parsing.js';
import { getSourceShardedParseFileCachePath } from '../../src/cli/parse-file-cache.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

class CountingJsonlAdapter implements SourceAdapter {
  public constructor(
    public readonly id: string,
    private readonly files: string[],
    private readonly parseCallCounter: { count: number },
  ) {}

  public async discoverFiles(): Promise<string[]> {
    return this.files;
  }

  public async parseFile(filePath: string) {
    this.parseCallCounter.count += 1;

    const content = await readFile(filePath, 'utf8');
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return [
      createUsageEvent({
        source: this.id,
        sessionId: path.basename(filePath, '.jsonl'),
        timestamp: '2026-02-01T00:00:00.000Z',
        totalTokens: lines.length || 1,
      }),
    ];
  }
}

class AuxiliaryDependencyAdapter implements SourceAdapter {
  public constructor(
    public readonly id: string,
    private readonly files: string[],
    private readonly parseCallCounter: { count: number },
    private readonly getDependencyPath: (filePath: string) => string,
  ) {}

  public async discoverFiles(): Promise<string[]> {
    return this.files;
  }

  public async getParseDependencies(filePath: string): Promise<string[]> {
    return [this.getDependencyPath(filePath)];
  }

  public async parseFile(filePath: string) {
    this.parseCallCounter.count += 1;

    const dependencyPath = this.getDependencyPath(filePath);
    const dependencyContent = await readFile(dependencyPath, 'utf8');

    return [
      createUsageEvent({
        source: this.id,
        sessionId: path.basename(filePath),
        timestamp: '2026-02-01T00:00:00.000Z',
        totalTokens: dependencyContent
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0).length,
      }),
    ];
  }
}

const parseCacheOptions = {
  parseCache: {
    enabled: true,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    maxEntries: 1_000,
    maxBytes: 16 * 1024 * 1024,
  },
};

function getCacheShardPath(cacheFilePath: string, source: string): string {
  return getSourceShardedParseFileCachePath(cacheFilePath, source);
}

describe('parseSelectedAdapters file cache', () => {
  it('reuses cached file parses on subsequent runs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-cache-hit-'));
    tempDirs.push(tempDir);

    const fileA = path.join(tempDir, 'a.jsonl');
    const fileB = path.join(tempDir, 'b.jsonl');
    const cacheFilePath = path.join(tempDir, 'parse-cache.json');
    await writeFile(fileA, '{"line":1}\n', 'utf8');
    await writeFile(fileB, '{"line":1}\n', 'utf8');

    const parseCalls = { count: 0 };
    const adapter = new CountingJsonlAdapter('counting', [fileA, fileB], parseCalls);

    const firstRun = await parseSelectedAdapters([adapter], 8, {
      ...parseCacheOptions,
      parseCacheFilePath: cacheFilePath,
    });

    expect(parseCalls.count).toBe(2);
    expect(firstRun.sourceFailures).toEqual([]);
    expect(firstRun.successfulParseResults[0]?.events).toHaveLength(2);

    const secondRun = await parseSelectedAdapters([adapter], 8, {
      ...parseCacheOptions,
      parseCacheFilePath: cacheFilePath,
    });

    expect(parseCalls.count).toBe(2);
    expect(secondRun.sourceFailures).toEqual([]);
    expect(secondRun.successfulParseResults[0]?.events).toHaveLength(2);
  });

  it('re-parses only files whose fingerprint changed', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-cache-change-'));
    tempDirs.push(tempDir);

    const fileA = path.join(tempDir, 'a.jsonl');
    const fileB = path.join(tempDir, 'b.jsonl');
    const cacheFilePath = path.join(tempDir, 'parse-cache.json');
    await writeFile(fileA, '{"line":1}\n', 'utf8');
    await writeFile(fileB, '{"line":1}\n', 'utf8');

    const firstPassCalls = { count: 0 };
    await parseSelectedAdapters(
      [new CountingJsonlAdapter('counting', [fileA, fileB], firstPassCalls)],
      8,
      {
        ...parseCacheOptions,
        parseCacheFilePath: cacheFilePath,
      },
    );
    expect(firstPassCalls.count).toBe(2);

    await writeFile(fileB, '{"line":1}\n{"line":2}\n', 'utf8');

    const secondPassCalls = { count: 0 };
    const secondRun = await parseSelectedAdapters(
      [new CountingJsonlAdapter('counting', [fileA, fileB], secondPassCalls)],
      8,
      {
        ...parseCacheOptions,
        parseCacheFilePath: cacheFilePath,
      },
    );

    expect(secondPassCalls.count).toBe(1);
    expect(secondRun.sourceFailures).toEqual([]);
    expect(secondRun.successfulParseResults[0]?.events).toHaveLength(2);
  });

  it('treats sub-millisecond mtime changes as cache fingerprint changes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-cache-sub-ms-mtime-'));
    tempDirs.push(tempDir);

    const fileA = path.join(tempDir, 'a.jsonl');
    const cacheFilePath = path.join(tempDir, 'parse-cache.json');
    await writeFile(fileA, '{"line":1}\n', 'utf8');

    const firstTimestampSeconds = 1_700_000_000.123_001;
    await utimes(fileA, firstTimestampSeconds, firstTimestampSeconds);
    const firstMtimeMs = (await stat(fileA)).mtimeMs;

    const firstPassCalls = { count: 0 };
    await parseSelectedAdapters(
      [new CountingJsonlAdapter('counting', [fileA], firstPassCalls)],
      8,
      {
        ...parseCacheOptions,
        parseCacheFilePath: cacheFilePath,
      },
    );
    expect(firstPassCalls.count).toBe(1);

    await writeFile(fileA, '{"line":2}\n', 'utf8');
    const secondTimestampSeconds = 1_700_000_000.123_777;
    await utimes(fileA, secondTimestampSeconds, secondTimestampSeconds);
    const secondMtimeMs = (await stat(fileA)).mtimeMs;

    // Some filesystems don't preserve sub-ms mtime precision. When that happens,
    // this scenario cannot exercise the regression and is validated elsewhere.
    if (firstMtimeMs === secondMtimeMs || Math.trunc(firstMtimeMs) !== Math.trunc(secondMtimeMs)) {
      return;
    }

    const secondPassCalls = { count: 0 };
    await parseSelectedAdapters(
      [new CountingJsonlAdapter('counting', [fileA], secondPassCalls)],
      8,
      {
        ...parseCacheOptions,
        parseCacheFilePath: cacheFilePath,
      },
    );

    expect(secondPassCalls.count).toBe(1);
  });

  it('caps cache size and avoids unbounded growth', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-cache-max-bytes-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'a.jsonl');
    const cacheFilePath = path.join(tempDir, 'parse-cache.json');
    await writeFile(filePath, '{"line":1}\n', 'utf8');

    const firstPassCalls = { count: 0 };
    await parseSelectedAdapters(
      [new CountingJsonlAdapter('counting', [filePath], firstPassCalls)],
      8,
      {
        parseCache: {
          enabled: true,
          ttlMs: 7 * 24 * 60 * 60 * 1000,
          maxEntries: 100,
          maxBytes: 300,
        },
        parseCacheFilePath: cacheFilePath,
      },
    );
    expect(firstPassCalls.count).toBe(1);

    const secondPassCalls = { count: 0 };
    await parseSelectedAdapters(
      [new CountingJsonlAdapter('counting', [filePath], secondPassCalls)],
      8,
      {
        parseCache: {
          enabled: true,
          ttlMs: 7 * 24 * 60 * 60 * 1000,
          maxEntries: 100,
          maxBytes: 300,
        },
        parseCacheFilePath: cacheFilePath,
      },
    );
    expect(secondPassCalls.count).toBe(1);

    const cacheFileContent = await readFile(getCacheShardPath(cacheFilePath, 'counting'), 'utf8');
    expect(Buffer.byteLength(cacheFileContent, 'utf8')).toBeLessThanOrEqual(300);
  });

  it('bypasses cache fingerprinting when discoverFiles returns virtual identifiers', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-cache-virtual-paths-'));
    tempDirs.push(tempDir);

    const cacheFilePath = path.join(tempDir, 'parse-cache.json');
    const parseCalls = { count: 0 };
    const virtualAdapter: SourceAdapter = {
      id: 'virtual',
      discoverFiles: async () => ['/virtual/source-entry'],
      parseFile: async () => {
        parseCalls.count += 1;
        return [
          createUsageEvent({
            source: 'virtual',
            sessionId: 'virtual-session',
            timestamp: '2026-02-01T00:00:00.000Z',
            totalTokens: 1,
          }),
        ];
      },
    };

    const firstRun = await parseSelectedAdapters([virtualAdapter], 8, {
      ...parseCacheOptions,
      parseCacheFilePath: cacheFilePath,
    });
    const secondRun = await parseSelectedAdapters([virtualAdapter], 8, {
      ...parseCacheOptions,
      parseCacheFilePath: cacheFilePath,
    });

    expect(firstRun.sourceFailures).toEqual([]);
    expect(secondRun.sourceFailures).toEqual([]);
    expect(parseCalls.count).toBe(2);
  });

  it('writes independent cache shards for each source', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-cache-sharded-by-source-'));
    tempDirs.push(tempDir);

    const cacheFilePath = path.join(tempDir, 'parse-cache.json');
    const codexFile = path.join(tempDir, 'codex.jsonl');
    const piFile = path.join(tempDir, 'pi.jsonl');

    await writeFile(codexFile, '{"line":1}\n', 'utf8');
    await writeFile(piFile, '{"line":1}\n', 'utf8');

    const codexCalls = { count: 0 };
    const piCalls = { count: 0 };
    const codexAdapter = new CountingJsonlAdapter('codex', [codexFile], codexCalls);
    const piAdapter = new CountingJsonlAdapter('pi', [piFile], piCalls);

    await parseSelectedAdapters([codexAdapter, piAdapter], 8, {
      ...parseCacheOptions,
      parseCacheFilePath: cacheFilePath,
    });

    const codexShard = getCacheShardPath(cacheFilePath, 'codex');
    const piShard = getCacheShardPath(cacheFilePath, 'pi');

    await expect(readFile(codexShard, 'utf8')).resolves.toContain('"source":"codex"');
    await expect(readFile(piShard, 'utf8')).resolves.toContain('"source":"pi"');
    await expect(readFile(cacheFilePath, 'utf8')).rejects.toThrow();
  });

  it.each([
    {
      source: 'droid',
      primaryFileName: 'session.settings.json',
      dependencyFileName: 'session.jsonl',
      getDependencyPath: (primaryFilePath: string) =>
        primaryFilePath.replace(/\.settings\.json$/u, '.jsonl'),
    },
    {
      source: 'gemini',
      primaryFileName: path.join('tmp', 'project-a', 'chats', 'session.json'),
      dependencyFileName: 'projects.json',
      getDependencyPath: (primaryFilePath: string) =>
        path.resolve(path.dirname(primaryFilePath), '..', '..', '..', 'projects.json'),
    },
    {
      source: 'opencode',
      primaryFileName: 'usage.db',
      dependencyFileName: 'usage.db-wal',
      getDependencyPath: (primaryFilePath: string) => `${primaryFilePath}-wal`,
    },
  ])(
    'reuses safe cache entries for %s and invalidates them when an auxiliary dependency changes',
    async ({ source, primaryFileName, dependencyFileName, getDependencyPath }) => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), `parse-cache-${source}-dependency-`));
      tempDirs.push(tempDir);

      const primaryFilePath = path.join(tempDir, primaryFileName);
      const dependencyFilePath = path.join(tempDir, dependencyFileName);
      const cacheFilePath = path.join(tempDir, 'parse-cache.json');

      await mkdir(path.dirname(primaryFilePath), { recursive: true });
      await mkdir(path.dirname(dependencyFilePath), { recursive: true });
      await writeFile(primaryFilePath, '{"primary":true}\n', 'utf8');
      await writeFile(dependencyFilePath, 'line-1\n', 'utf8');

      const parseCalls = { count: 0 };
      const adapter = new AuxiliaryDependencyAdapter(
        source,
        [primaryFilePath],
        parseCalls,
        getDependencyPath,
      );

      const firstRun = await parseSelectedAdapters([adapter], 8, {
        ...parseCacheOptions,
        parseCacheFilePath: cacheFilePath,
      });

      expect(firstRun.sourceFailures).toEqual([]);
      expect(firstRun.successfulParseResults[0]?.events[0]?.totalTokens).toBe(1);
      expect(parseCalls.count).toBe(1);
      await expect(readFile(getCacheShardPath(cacheFilePath, source), 'utf8')).resolves.toContain(
        `"source":"${source}"`,
      );

      const cachedRun = await parseSelectedAdapters([adapter], 8, {
        ...parseCacheOptions,
        parseCacheFilePath: cacheFilePath,
      });

      expect(cachedRun.sourceFailures).toEqual([]);
      expect(cachedRun.successfulParseResults[0]?.events[0]?.totalTokens).toBe(1);
      expect(parseCalls.count).toBe(1);

      await writeFile(dependencyFilePath, 'line-1\nline-2\n', 'utf8');

      const invalidatedRun = await parseSelectedAdapters([adapter], 8, {
        ...parseCacheOptions,
        parseCacheFilePath: cacheFilePath,
      });

      expect(invalidatedRun.sourceFailures).toEqual([]);
      expect(invalidatedRun.successfulParseResults[0]?.events[0]?.totalTokens).toBe(2);
      expect(parseCalls.count).toBe(2);
      await expect(readFile(getCacheShardPath(cacheFilePath, source), 'utf8')).resolves.toContain(
        `"source":"${source}"`,
      );
    },
  );
});
