import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getSourceShardedParseFileCachePath,
  ParseFileCache,
} from '../../src/cli/parse-file-cache.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function createEvent(overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {}) {
  return createUsageEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp: '2026-02-01T00:00:00.000Z',
    inputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 3,
    costMode: 'estimated',
    ...overrides,
  });
}

describe('ParseFileCache', () => {
  describe('getSourceShardedParseFileCachePath', () => {
    it('adds source shard before file extension', () => {
      expect(getSourceShardedParseFileCachePath('/tmp/parse-file-cache.json', 'Droid')).toBe(
        '/tmp/parse-file-cache.droid.json',
      );
    });

    it('handles cache file paths without extension', () => {
      expect(getSourceShardedParseFileCachePath('/tmp/parse-file-cache', 'pi')).toBe(
        '/tmp/parse-file-cache.pi',
      );
    });

    it('normalizes unsupported source characters', () => {
      expect(getSourceShardedParseFileCachePath('/tmp/parse-file-cache.json', 'my/source id')).toBe(
        '/tmp/parse-file-cache.my_source_id.json',
      );
    });
  });

  it('persists and reloads diagnostics while preserving nested skipped row reasons', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-roundtrip-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');
    let nowMs = 10_000;
    const now = () => nowMs;

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now,
    });

    cache.set(
      'codex',
      '/tmp/a.jsonl',
      { size: 5, mtimeMs: 11.75 },
      {
        events: [createEvent()],
        skippedRows: 3,
        skippedRowReasons: [{ reason: 'malformed json', count: 2 }],
      },
    );
    await cache.persist();

    nowMs += 1;

    const reloaded = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now,
    });
    const firstGet = reloaded.get('codex', '/tmp/a.jsonl', { size: 5, mtimeMs: 11.75 });

    expect(firstGet).toEqual({
      events: [createEvent()],
      skippedRows: 3,
      skippedRowReasons: [{ reason: 'malformed json', count: 2 }],
    });

    if (!firstGet) {
      throw new Error('expected cached diagnostics');
    }

    firstGet.events[0].sessionId = 'mutated';
    if (firstGet.skippedRowReasons) {
      firstGet.skippedRowReasons[0].count = 999;
    }

    const secondGet = reloaded.get('codex', '/tmp/a.jsonl', { size: 5, mtimeMs: 11.75 });
    expect(secondGet?.events[0]?.sessionId).toBe('session-1');
    expect(secondGet?.skippedRowReasons?.[0]?.count).toBe(2);
  });

  it('returns undefined for fingerprint mismatches and expired entries', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-expiry-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');
    let nowMs = 50_000;
    const now = () => nowMs;
    const limits = { ttlMs: 100, maxEntries: 100, maxBytes: 1024 * 1024 };

    const cache = await ParseFileCache.load({ cacheFilePath, limits, now });
    cache.set(
      'codex',
      '/tmp/b.jsonl',
      { size: 10, mtimeMs: 20 },
      { events: [createEvent()], skippedRows: 0 },
    );

    expect(cache.get('codex', '/tmp/b.jsonl', { size: 11, mtimeMs: 20 })).toBeUndefined();

    nowMs += 101;
    expect(cache.get('codex', '/tmp/b.jsonl', { size: 10, mtimeMs: 20 })).toBeUndefined();

    await cache.persist();
    const payload = JSON.parse(await readFile(cacheFilePath, 'utf8')) as { entries: unknown[] };
    expect(payload.entries).toHaveLength(0);
  });

  it('evicts stale fingerprint entries so they do not persist forever', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-fingerprint-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');
    const limits = { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 };

    const cache = await ParseFileCache.load({ cacheFilePath, limits, now: () => 1_000 });
    cache.set(
      'codex',
      '/tmp/cached.jsonl',
      { size: 10, mtimeMs: 20 },
      { events: [createEvent()], skippedRows: 0 },
    );

    expect(cache.get('codex', '/tmp/cached.jsonl', { size: 11, mtimeMs: 20 })).toBeUndefined();

    await cache.persist();
    const payload = JSON.parse(await readFile(cacheFilePath, 'utf8')) as { entries: unknown[] };
    expect(payload.entries).toHaveLength(0);
  });

  it('drops entries evicted during persist from in-memory reads too', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-persist-eviction-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');
    let nowMs = 1_000;
    const now = () => nowMs;

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 1, maxBytes: 1024 * 1024 },
      now,
    });

    cache.set(
      'codex',
      '/tmp/older.jsonl',
      { size: 10, mtimeMs: 20 },
      { events: [createEvent({ sessionId: 'older' })], skippedRows: 0 },
    );

    nowMs += 1;

    cache.set(
      'codex',
      '/tmp/newer.jsonl',
      { size: 11, mtimeMs: 21 },
      { events: [createEvent({ sessionId: 'newer' })], skippedRows: 0 },
    );

    await cache.persist();

    expect(cache.get('codex', '/tmp/older.jsonl', { size: 10, mtimeMs: 20 })).toBeUndefined();
    expect(cache.get('codex', '/tmp/newer.jsonl', { size: 11, mtimeMs: 21 })).toEqual({
      events: [createEvent({ sessionId: 'newer' })],
      skippedRows: 0,
      skippedRowReasons: [],
    });
  });

  it('normalizes source IDs in set/get keys and keeps lookups stable after reload', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-source-key-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now: () => 1_000,
    });

    cache.set(
      'CODEX',
      '/tmp/normalized-source.jsonl',
      { size: 10, mtimeMs: 20 },
      { events: [createEvent()], skippedRows: 0 },
    );

    expect(cache.get('codex', '/tmp/normalized-source.jsonl', { size: 10, mtimeMs: 20 })).toEqual({
      events: [createEvent()],
      skippedRows: 0,
      skippedRowReasons: [],
    });

    await cache.persist();

    const reloaded = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now: () => 1_001,
    });

    expect(
      reloaded.get('CODEX', '/tmp/normalized-source.jsonl', { size: 10, mtimeMs: 20 }),
    ).toEqual({
      events: [createEvent()],
      skippedRows: 0,
      skippedRowReasons: [],
    });
  });

  it('normalizes disk payload entries and ignores malformed rows', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-load-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');
    const validEvent = {
      source: 'CODEX',
      sessionId: 'from-cache',
      timestamp: '2026-02-01T00:00:00.000Z',
      provider: ' OpenAI-Codex ',
      model: ' GPT-4.1 ',
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 3,
      costMode: 'estimated',
    };

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        version: 5,
        entries: [
          {
            source: 'CODEX',
            filePath: '/tmp/ok.jsonl',
            fingerprint: { size: 12, mtimeMs: 34 },
            cachedAt: 42,
            diagnostics: {
              events: [validEvent],
              skippedRows: 9,
              skippedRowReasons: [
                { reason: ' truncated ', count: 3.9 },
                { reason: 'zero', count: 0 },
                { reason: '', count: 1 },
              ],
            },
          },
          {
            source: 'codex',
            filePath: '/tmp/bad.jsonl',
            fingerprint: { size: 12, mtimeMs: 34 },
            cachedAt: 42,
            diagnostics: {
              events: [{ source: 'codex' }],
              skippedRows: 0,
              skippedRowReasons: [{ reason: 'x', count: 1 }],
            },
          },
          {
            source: 'codex',
            filePath: '/tmp/bad-source.jsonl',
            fingerprint: { size: 12, mtimeMs: 34 },
            cachedAt: 42,
            diagnostics: {
              events: [{ ...validEvent, source: '   ' }],
              skippedRows: 0,
              skippedRowReasons: [{ reason: 'x', count: 1 }],
            },
          },
          {
            source: 'codex',
            filePath: '/tmp/bad-timestamp.jsonl',
            fingerprint: { size: 12, mtimeMs: 34 },
            cachedAt: 42,
            diagnostics: {
              events: [{ ...validEvent, timestamp: '2026-02-01T00:00:00Z' }],
              skippedRows: 0,
              skippedRowReasons: [{ reason: 'x', count: 1 }],
            },
          },
        ],
      }),
      'utf8',
    );

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now: () => 1_000,
    });

    expect(cache.get('codex', '/tmp/bad.jsonl', { size: 12, mtimeMs: 34 })).toBeUndefined();
    expect(cache.get('codex', '/tmp/bad-source.jsonl', { size: 12, mtimeMs: 34 })).toBeUndefined();
    expect(
      cache.get('codex', '/tmp/bad-timestamp.jsonl', { size: 12, mtimeMs: 34 }),
    ).toBeUndefined();
    expect(cache.get('codex', '/tmp/ok.jsonl', { size: 12, mtimeMs: 34 })).toEqual({
      events: [
        { ...createEvent({ sessionId: 'from-cache', provider: 'openai', model: 'gpt-4.1' }) },
      ],
      skippedRows: 9,
      skippedRowReasons: [{ reason: 'truncated', count: 3 }],
    });

    await cache.persist();
    const persisted = JSON.parse(await readFile(cacheFilePath, 'utf8')) as { entries: unknown[] };
    expect(persisted.entries).toHaveLength(1);
  });

  it('rejects disk cache entries with malformed dependency fingerprints', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-bad-dependency-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        version: 5,
        entries: [
          {
            source: 'codex',
            filePath: '/tmp/ok.jsonl',
            fingerprint: {
              dependencies: [
                { path: '/tmp/ok.jsonl', exists: true, size: 12, mtimeMs: 34 },
                { path: '   ', exists: true, size: 1, mtimeMs: 2 },
              ],
            },
            cachedAt: 42,
            diagnostics: {
              events: [createEvent()],
              skippedRows: 0,
              skippedRowReasons: [],
            },
          },
        ],
      }),
      'utf8',
    );

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now: () => 1_000,
    });

    expect(
      cache.get('codex', '/tmp/ok.jsonl', {
        dependencies: [{ path: '/tmp/ok.jsonl', exists: true, size: 12, mtimeMs: 34 }],
      }),
    ).toBeUndefined();
  });

  it('rejects disk cache entries when dependencies is present but not an array', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-invalid-dependencies-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        version: 5,
        entries: [
          {
            source: 'codex',
            filePath: '/tmp/ok.jsonl',
            fingerprint: {
              dependencies: {
                path: '/tmp/ok.jsonl',
                exists: true,
                size: 12,
                mtimeMs: 34,
              },
              size: 12,
              mtimeMs: 34,
            },
            cachedAt: 42,
            diagnostics: {
              events: [createEvent()],
              skippedRows: 0,
              skippedRowReasons: [],
            },
          },
        ],
      }),
      'utf8',
    );

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now: () => 1_000,
    });

    expect(
      cache.get('codex', '/tmp/ok.jsonl', {
        dependencies: [{ path: '/tmp/ok.jsonl', exists: true, size: 12, mtimeMs: 34 }],
      }),
    ).toBeUndefined();
  });

  it('round-trips missing dependency fingerprints and rejects malformed runtime fingerprints', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-missing-dependency-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now: () => 1_000,
    });

    cache.set(
      'codex',
      '/tmp/ok.jsonl',
      {
        dependencies: [
          { path: '/tmp/missing-sidecar.json', exists: false },
          { path: '/tmp/ok.jsonl', exists: true, size: 12, mtimeMs: 34 },
        ],
      },
      { events: [createEvent()], skippedRows: 0 },
    );

    await cache.persist();

    const reloaded = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now: () => 1_001,
    });

    expect(
      reloaded.get('codex', '/tmp/ok.jsonl', {
        dependencies: [
          { path: '/tmp/missing-sidecar.json', exists: false },
          { path: '/tmp/ok.jsonl', exists: true, size: 12, mtimeMs: 34 },
        ],
      }),
    ).toEqual({
      events: [createEvent()],
      skippedRows: 0,
      skippedRowReasons: [],
    });

    expect(
      reloaded.get('codex', '/tmp/ok.jsonl', {
        dependencies: [{ path: '/tmp/ok.jsonl', exists: true, mtimeMs: 34 }],
      }),
    ).toBeUndefined();
  });

  it('drops stale and oversized loaded entries on persist', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-load-cleanup-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        version: 5,
        entries: [
          {
            source: 'codex',
            filePath: '/tmp/stale.jsonl',
            fingerprint: { size: 1, mtimeMs: 1 },
            cachedAt: 0,
            diagnostics: { events: [createEvent()], skippedRows: 0, skippedRowReasons: [] },
          },
          {
            source: 'codex',
            filePath: '/tmp/fresh-a.jsonl',
            fingerprint: { size: 2, mtimeMs: 2 },
            cachedAt: 100,
            diagnostics: {
              events: [createEvent({ sessionId: 'a' })],
              skippedRows: 0,
              skippedRowReasons: [],
            },
          },
          {
            source: 'codex',
            filePath: '/tmp/fresh-b.jsonl',
            fingerprint: { size: 3, mtimeMs: 3 },
            cachedAt: 101,
            diagnostics: {
              events: [createEvent({ sessionId: 'b' })],
              skippedRows: 0,
              skippedRowReasons: [],
            },
          },
        ],
      }),
      'utf8',
    );

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 50, maxEntries: 1, maxBytes: 1024 * 1024 },
      now: () => 120,
    });

    expect(
      cache.get('codex', '/tmp/fresh-a.jsonl', {
        size: 2,
        mtimeMs: 2,
      }),
    ).toBeUndefined();
    expect(
      cache.get('codex', '/tmp/fresh-b.jsonl', {
        size: 3,
        mtimeMs: 3,
      }),
    ).toEqual({
      events: [createEvent({ sessionId: 'b' })],
      skippedRows: 0,
      skippedRowReasons: [],
    });

    await cache.persist();
    const persisted = JSON.parse(await readFile(cacheFilePath, 'utf8')) as {
      entries: Array<{ filePath: string }>;
    };

    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0]?.filePath).toBe('/tmp/fresh-b.jsonl');
  });

  it('recovers from malformed cache JSON and rewrites a valid payload', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-malformed-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');
    await writeFile(cacheFilePath, '{not-json', 'utf8');

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now: () => 500,
    });

    await cache.persist();
    const persisted = JSON.parse(await readFile(cacheFilePath, 'utf8')) as {
      version: number;
      entries: unknown[];
    };
    expect(persisted).toEqual({ version: 5, entries: [] });
  });

  it('handles unsupported cache versions by resetting payload on persist', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-version-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');
    await writeFile(
      cacheFilePath,
      JSON.stringify({ version: 999, entries: [{ source: 'codex' }] }),
      'utf8',
    );

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now: () => 500,
    });

    await cache.persist();
    const persisted = JSON.parse(await readFile(cacheFilePath, 'utf8')) as {
      version: number;
      entries: unknown[];
    };
    expect(persisted).toEqual({ version: 5, entries: [] });
  });

  it('bounds persisted payload by max entries and max bytes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-bounds-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');
    let nowMs = 10;
    const now = () => nowMs;

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 2, maxBytes: 220 },
      now,
    });

    const oversizedEvent = createEvent({ sessionId: 'x'.repeat(200) });
    cache.set(
      'codex',
      '/tmp/one.jsonl',
      { size: 1, mtimeMs: 1 },
      { events: [oversizedEvent], skippedRows: 0 },
    );
    nowMs += 1;
    cache.set(
      'codex',
      '/tmp/two.jsonl',
      { size: 2, mtimeMs: 2 },
      { events: [oversizedEvent], skippedRows: 0 },
    );
    nowMs += 1;
    cache.set(
      'codex',
      '/tmp/three.jsonl',
      { size: 3, mtimeMs: 3 },
      { events: [oversizedEvent], skippedRows: 0 },
    );

    await cache.persist();
    const persistedText = await readFile(cacheFilePath, 'utf8');
    const persisted = JSON.parse(persistedText) as { entries: Array<{ filePath: string }> };

    expect(Buffer.byteLength(persistedText, 'utf8')).toBeLessThanOrEqual(220);
    expect(persisted.entries.length).toBeLessThanOrEqual(2);
  });

  it('does not write cache file when nothing changed', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-pristine-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now: () => 100,
    });

    await cache.persist();
    await expect(readFile(cacheFilePath, 'utf8')).rejects.toThrow();
  });

  it('skips oversized cache payloads before loading entries', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-oversized-load-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');

    const oversizedEvent = createEvent({ sessionId: 'oversized-session-id'.repeat(100) });
    await writeFile(
      cacheFilePath,
      JSON.stringify({
        version: 5,
        entries: [
          {
            source: 'codex',
            filePath: '/tmp/oversized.jsonl',
            fingerprint: { size: 12, mtimeMs: 34 },
            cachedAt: 1,
            diagnostics: { events: [oversizedEvent], skippedRows: 0, skippedRowReasons: [] },
          },
        ],
      }),
      'utf8',
    );

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 300 },
      now: () => 100,
    });

    expect(cache.get('codex', '/tmp/oversized.jsonl', { size: 12, mtimeMs: 34 })).toBeUndefined();

    await cache.persist();
    const persisted = JSON.parse(await readFile(cacheFilePath, 'utf8')) as { entries: unknown[] };
    expect(persisted.entries).toHaveLength(0);
  });

  it('does not leave temporary files after atomic persist', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-file-cache-atomic-persist-'));
    tempDirs.push(tempDir);
    const cacheFilePath = path.join(tempDir, 'parse-file-cache.json');

    const cache = await ParseFileCache.load({
      cacheFilePath,
      limits: { ttlMs: 60_000, maxEntries: 100, maxBytes: 1024 * 1024 },
      now: () => 1_000,
    });
    cache.set(
      'codex',
      '/tmp/atomic.jsonl',
      { size: 1, mtimeMs: 1 },
      { events: [createEvent()], skippedRows: 0 },
    );

    await cache.persist();

    const files = await readdir(tempDir);
    expect(files).toEqual(['parse-file-cache.json']);
  });
});
