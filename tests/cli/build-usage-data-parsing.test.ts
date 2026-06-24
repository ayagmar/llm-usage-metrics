import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  filterUsageEvents,
  parseSelectedAdapters,
} from '../../src/cli/build-usage-data-parsing.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';
import { ParseFileCache } from '../../src/cli/parse-file-cache.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function createDelayedAdapter(
  id: string,
  filePath: string,
  stats: { current: number; max: number },
): SourceAdapter {
  return {
    id,
    discoverFiles: async () => [filePath],
    parseFile: async () => {
      stats.current += 1;
      stats.max = Math.max(stats.max, stats.current);

      try {
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });

        return [
          createUsageEvent({
            source: id,
            sessionId: `${id}-session`,
            timestamp: '2026-02-01T00:00:00.000Z',
            inputTokens: 1,
            totalTokens: 1,
          }),
        ];
      } finally {
        stats.current -= 1;
      }
    },
  };
}

function rejectWithUnknown(reason: unknown): Promise<never> {
  return (async () => {
    throw reason;
  })();
}

describe('build-usage-data-parsing', () => {
  it('enforces one global parse concurrency budget across adapters', async () => {
    const stats = { current: 0, max: 0 };

    const result = await parseSelectedAdapters(
      [
        createDelayedAdapter('pi', '/tmp/pi-delayed.jsonl', stats),
        createDelayedAdapter('codex', '/tmp/codex-delayed.jsonl', stats),
      ],
      1,
    );

    expect(result.sourceFailures).toEqual([]);
    expect(result.successfulParseResults).toHaveLength(2);
    expect(stats.max).toBe(1);
  });

  it('stringifies non-Error parse failures and deduplicates cache loads by source id', async () => {
    const parseFileCache = {
      get: vi.fn(),
      set: vi.fn(),
      persist: vi.fn(async () => undefined),
    } as unknown as ParseFileCache;
    const loadSpy = vi.spyOn(ParseFileCache, 'load').mockResolvedValue(parseFileCache);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-selected-adapters-cache-'));
    tempDirs.push(tempDir);
    const failingAdapter: SourceAdapter = {
      id: 'CoDex',
      discoverFiles: () => rejectWithUnknown('plain failure') as Promise<string[]>,
      parseFile: async () => [],
    };
    const succeedingAdapter: SourceAdapter = {
      id: 'codex',
      discoverFiles: async () => [],
      parseFile: async () => [],
    };

    const result = await parseSelectedAdapters([failingAdapter, succeedingAdapter], 1, {
      parseCache: {
        enabled: true,
        ttlMs: 60_000,
        maxEntries: 100,
        maxBytes: 1024 * 1024,
      },
      parseCacheFilePath: path.join(tempDir, 'parse-selected-adapters-test-cache.json'),
    });

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(result.sourceFailures).toEqual([{ source: 'CoDex', reason: 'plain failure' }]);
    expect(result.successfulParseResults).toHaveLength(1);
  });

  it('parses direct source adapters without file discovery or parse cache', async () => {
    const discoverFiles = vi.fn(async () => ['/tmp/should-not-be-used.jsonl']);
    const parseFile = vi.fn(async () => []);
    const adapter: SourceAdapter = {
      id: 'anthropic-api',
      capabilities: { requiresExplicitSelection: true },
      discoverFiles,
      parseFile,
      parseSourceWithDiagnostics: async () => ({
        events: [
          createUsageEvent({
            source: 'anthropic-api',
            sessionId: 'api-2026-02-01',
            timestamp: '2026-02-01T00:00:00.000Z',
            provider: 'anthropic',
            model: 'claude-opus-4-8',
            inputTokens: 1,
            totalTokens: 1,
          }),
        ],
        skippedRows: 2,
        skippedRowReasons: [{ reason: 'invalid_result', count: 2 }],
        sourceItemsFound: 3,
      }),
    };

    const result = await parseSelectedAdapters([adapter], 1, {
      parseCache: {
        enabled: true,
        ttlMs: 60_000,
        maxEntries: 100,
        maxBytes: 1024 * 1024,
      },
    });

    expect(discoverFiles).not.toHaveBeenCalled();
    expect(parseFile).not.toHaveBeenCalled();
    expect(result.sourceFailures).toEqual([]);
    expect(result.successfulParseResults).toEqual([
      {
        source: 'anthropic-api',
        events: [expect.objectContaining({ sessionId: 'api-2026-02-01' })],
        filesFound: 3,
        skippedRows: 2,
        skippedRowReasons: [{ reason: 'invalid_result', count: 2 }],
      },
    ]);
  });

  it('filters out events without model data when a model filter is active', () => {
    const filtered = filterUsageEvents(
      [
        createUsageEvent({
          source: 'pi',
          sessionId: 'missing-model',
          timestamp: '2026-02-01T00:00:00.000Z',
          totalTokens: 1,
        }),
        createUsageEvent({
          source: 'pi',
          sessionId: 'with-model',
          timestamp: '2026-02-01T00:00:00.000Z',
          model: 'gpt-4.1',
          totalTokens: 1,
        }),
      ],
      {
        timezone: 'UTC',
        modelFilter: ['gpt-4.1'],
      },
    );

    expect(filtered.map((event) => event.sessionId)).toEqual(['with-model']);
  });
});
