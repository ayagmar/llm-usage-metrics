import { describe, expect, it } from 'vitest';

import {
  filterUsageEvents,
  parseSelectedAdapters,
} from '../../src/cli/build-usage-data-parsing.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

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

      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });

      stats.current -= 1;

      return [
        createUsageEvent({
          source: id,
          sessionId: `${id}-session`,
          timestamp: '2026-02-01T00:00:00.000Z',
          inputTokens: 1,
          totalTokens: 1,
        }),
      ];
    },
  };
}

function rejectWithUnknown(reason: unknown): Promise<never> {
  const rejected = {
    then: (
      _onFulfilled: ((value: never) => unknown) | undefined,
      onRejected: ((reason: unknown) => unknown) | undefined,
    ) => Promise.resolve(onRejected?.(reason)),
    catch: (onRejected: ((value: unknown) => unknown) | undefined) =>
      Promise.resolve(onRejected?.(reason)),
    finally: (onFinally: (() => void) | undefined) => Promise.resolve(onFinally?.()),
    [Symbol.toStringTag]: 'Promise',
  };

  return rejected as unknown as Promise<never>;
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
    const failingAdapter: SourceAdapter = {
      id: 'codex',
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
      parseCacheFilePath: '/tmp/parse-selected-adapters-test-cache.json',
    });

    expect(result.sourceFailures).toEqual([{ source: 'codex', reason: 'plain failure' }]);
    expect(result.successfulParseResults).toHaveLength(1);
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
