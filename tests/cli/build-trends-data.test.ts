import { describe, expect, it, vi } from 'vitest';

import { buildTrendsData } from '../../src/cli/build-trends-data.js';
import type { PricingLoadResult } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';
import { createDefaultOpenAiPricingSource } from '../helpers/static-pricing-source.js';

function createAdapter(
  id: SourceAdapter['id'],
  eventsByFile: Record<string, ReturnType<typeof createUsageEvent>[]>,
): SourceAdapter {
  const files = Object.keys(eventsByFile);

  return {
    id,
    discoverFiles: async () => files,
    parseFile: async (filePath) => eventsByFile[filePath] ?? [],
  };
}

function runtimeDeps(
  overrides: {
    adapters?: SourceAdapter[];
    resolvePricingSource?: () => Promise<PricingLoadResult>;
    now?: () => Date;
  } = {},
) {
  return {
    getParsingRuntimeConfig: () => ({
      maxParallelFileParsing: 2,
      parseCacheEnabled: false,
      parseCacheTtlMs: 7 * 24 * 60 * 60 * 1000,
      parseCacheMaxEntries: 2_000,
      parseCacheMaxBytes: 64 * 1024 * 1024,
    }),
    getPricingFetcherRuntimeConfig: () => ({ cacheTtlMs: 1_000, fetchTimeoutMs: 1_000 }),
    getActiveEnvVarOverrides: () => [],
    createAdapters: () => overrides.adapters ?? [],
    resolvePricingSource:
      overrides.resolvePricingSource ??
      (async () => ({
        source: createDefaultOpenAiPricingSource(),
        origin: 'cache',
      })),
    now: overrides.now,
  };
}

function createBaseEvent(overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {}) {
  return createUsageEvent({
    source: 'pi',
    sessionId: 'session-1',
    timestamp: '2026-03-05T10:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 15,
    costMode: 'estimated',
    ...overrides,
  });
}

describe('buildTrendsData', () => {
  it('defaults to the last 30 local calendar days when no date flags are provided', async () => {
    const result = await buildTrendsData(
      {
        metric: 'tokens',
      },
      runtimeDeps({
        now: () => new Date('2026-03-06T12:00:00.000Z'),
        adapters: [
          createAdapter('pi', {
            '/tmp/a.jsonl': [
              createBaseEvent({ timestamp: '2026-03-05T10:00:00.000Z' }),
              createBaseEvent({ timestamp: '2026-02-05T10:00:00.000Z' }),
            ],
          }),
        ],
      }),
    );

    expect(result.metric).toBe('tokens');
    expect(result.dateRange).toEqual({ from: '2026-02-05', to: '2026-03-06' });
    expect(result.totalSeries.buckets).toHaveLength(30);
    expect(result.totalSeries.summary.observedDayCount).toBe(2);
  });

  it('does not load pricing for token trends', async () => {
    const pricingLoaderSpy = vi.fn(async () => ({
      source: createDefaultOpenAiPricingSource(),
      origin: 'cache' as const,
    }));

    const result = await buildTrendsData(
      {
        metric: 'tokens',
      },
      runtimeDeps({
        now: () => new Date('2026-03-06T12:00:00.000Z'),
        adapters: [
          createAdapter('pi', {
            '/tmp/a.jsonl': [createBaseEvent()],
          }),
        ],
        resolvePricingSource: pricingLoaderSpy,
      }),
    );

    expect(pricingLoaderSpy).not.toHaveBeenCalled();
    expect(result.diagnostics.pricingOrigin).toBe('none');
  });

  it('rejects --days when combined with explicit date flags', async () => {
    await expect(
      buildTrendsData(
        {
          days: '7',
          since: '2026-03-01',
        },
        runtimeDeps(),
      ),
    ).rejects.toThrow('--days cannot be combined with --since or --until');
  });

  it('resolves --until-only ranges from the earliest observed local day', async () => {
    const result = await buildTrendsData(
      {
        until: '2026-03-06',
        metric: 'tokens',
      },
      runtimeDeps({
        now: () => new Date('2026-03-06T12:00:00.000Z'),
        adapters: [
          createAdapter('pi', {
            '/tmp/a.jsonl': [
              createBaseEvent({ timestamp: '2026-03-04T10:00:00.000Z' }),
              createBaseEvent({ timestamp: '2026-03-06T10:00:00.000Z' }),
            ],
          }),
        ],
      }),
    );

    expect(result.dateRange).toEqual({ from: '2026-03-04', to: '2026-03-06' });
    expect(result.totalSeries.buckets.map((bucket) => bucket.date)).toEqual([
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
    ]);
  });
});
