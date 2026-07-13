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
      parseWorkers: 0,
      parseWorkerMinBytes: 268_435_456,
    }),
    getPricingFetcherRuntimeConfig: () => ({ cacheTtlMs: 1_000, fetchTimeoutMs: 1_000 }),
    getEventStoreRuntimeConfig: () => ({
      enabled: false as const,
      path: '/tmp/events.db',
      disabledBy: 'environment' as const,
    }),
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

  it('computes gap-capped active time per day and source for active-hours trends', async () => {
    const pricingLoaderSpy = vi.fn(async () => ({
      source: createDefaultOpenAiPricingSource(),
      origin: 'cache' as const,
    }));

    const result = await buildTrendsData(
      {
        metric: 'active-hours',
        since: '2026-03-05',
        until: '2026-03-06',
        timezone: 'UTC',
        bySource: true,
      },
      runtimeDeps({
        now: () => new Date('2026-03-06T12:00:00.000Z'),
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [
              // One session with a 10-minute gap (capped to 5 minutes) plus a
              // single-event session that contributes zero.
              createBaseEvent({ sessionId: 'gapped', timestamp: '2026-03-05T10:00:00.000Z' }),
              createBaseEvent({ sessionId: 'gapped', timestamp: '2026-03-05T10:10:00.000Z' }),
              createBaseEvent({ sessionId: 'solo', timestamp: '2026-03-05T11:00:00.000Z' }),
            ],
          }),
          createAdapter('codex', {
            '/tmp/codex.jsonl': [
              createBaseEvent({
                source: 'codex',
                sessionId: 'codex-a',
                timestamp: '2026-03-06T09:00:00.000Z',
              }),
              createBaseEvent({
                source: 'codex',
                sessionId: 'codex-a',
                timestamp: '2026-03-06T09:02:00.000Z',
              }),
            ],
          }),
        ],
        resolvePricingSource: pricingLoaderSpy,
      }),
    );

    expect(result.metric).toBe('active-hours');
    expect(result.totalSeries.buckets).toEqual([
      { date: '2026-03-05', value: 300_000, observed: true, incomplete: undefined },
      { date: '2026-03-06', value: 120_000, observed: true, incomplete: undefined },
    ]);
    expect(result.sourceSeries?.map((series) => series.source)).toEqual(['pi', 'codex']);
    expect(result.sourceSeries?.[0]?.buckets.map((bucket) => bucket.value)).toEqual([300_000, 0]);
    expect(result.sourceSeries?.[1]?.buckets.map((bucket) => bucket.value)).toEqual([0, 120_000]);
    expect(pricingLoaderSpy).not.toHaveBeenCalled();
    expect(result.diagnostics.pricingOrigin).toBe('none');
  });

  it('uses explicit trailing day ranges when --days is provided', async () => {
    const result = await buildTrendsData(
      {
        metric: 'tokens',
        days: '3',
      },
      runtimeDeps({
        now: () => new Date('2026-03-06T12:00:00.000Z'),
        adapters: [
          createAdapter('pi', {
            '/tmp/a.jsonl': [createBaseEvent({ timestamp: '2026-03-05T10:00:00.000Z' })],
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

  it('rejects invalid days, metric, and date ordering inputs', async () => {
    await expect(
      buildTrendsData(
        {
          days: '0',
        },
        runtimeDeps(),
      ),
    ).rejects.toThrow('--days must be a positive integer');

    await expect(
      buildTrendsData(
        {
          metric: 'latency',
        } as never,
        runtimeDeps(),
      ),
    ).rejects.toThrow('--metric must be one of: cost, tokens, active-hours');

    await expect(
      buildTrendsData(
        {
          since: '2026-03-07',
          until: '2026-03-06',
        },
        runtimeDeps(),
      ),
    ).rejects.toThrow('--since must be less than or equal to --until');
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

  it('uses the current day as the upper bound for past --since-only ranges', async () => {
    const result = await buildTrendsData(
      {
        since: '2026-03-04',
        metric: 'tokens',
      },
      runtimeDeps({
        now: () => new Date('2026-03-06T12:00:00.000Z'),
        adapters: [
          createAdapter('pi', {
            '/tmp/a.jsonl': [createBaseEvent({ timestamp: '2026-03-05T10:00:00.000Z' })],
          }),
        ],
      }),
    );

    expect(result.dateRange).toEqual({ from: '2026-03-04', to: '2026-03-06' });
  });

  it('keeps future --since-only ranges pinned to the requested day', async () => {
    const result = await buildTrendsData(
      {
        since: '2026-03-08',
        metric: 'tokens',
      },
      runtimeDeps({
        now: () => new Date('2026-03-06T12:00:00.000Z'),
        adapters: [
          createAdapter('pi', {
            '/tmp/a.jsonl': [createBaseEvent({ timestamp: '2026-03-05T10:00:00.000Z' })],
          }),
        ],
      }),
    );

    expect(result.dateRange).toEqual({ from: '2026-03-08', to: '2026-03-08' });
    expect(result.totalSeries.buckets).toEqual([{ date: '2026-03-08', value: 0, observed: false }]);
  });

  it('falls back to the requested --until day when no observations exist', async () => {
    const result = await buildTrendsData(
      {
        until: '2026-03-06',
        metric: 'tokens',
      },
      runtimeDeps({
        now: () => new Date('2026-03-06T12:00:00.000Z'),
        adapters: [createAdapter('pi', {})],
      }),
    );

    expect(result.dateRange).toEqual({ from: '2026-03-06', to: '2026-03-06' });
    expect(result.totalSeries.buckets).toEqual([{ date: '2026-03-06', value: 0, observed: false }]);
  });

  it('ignores future-only observations when resolving an --until-only range', async () => {
    const result = await buildTrendsData(
      {
        until: '2026-03-06',
        metric: 'tokens',
      },
      runtimeDeps({
        now: () => new Date('2026-03-10T12:00:00.000Z'),
        adapters: [
          createAdapter('pi', {
            '/tmp/a.jsonl': [createBaseEvent({ timestamp: '2026-03-08T10:00:00.000Z' })],
          }),
        ],
      }),
    );

    expect(result.dateRange).toEqual({ from: '2026-03-06', to: '2026-03-06' });
    expect(result.totalSeries.buckets).toEqual([{ date: '2026-03-06', value: 0, observed: false }]);
  });

  it('returns ordered per-source trend series when --by-source is enabled', async () => {
    const result = await buildTrendsData(
      {
        metric: 'tokens',
        bySource: true,
        since: '2026-03-04',
        until: '2026-03-05',
      },
      runtimeDeps({
        now: () => new Date('2026-03-06T12:00:00.000Z'),
        adapters: [
          createAdapter('pi', {
            '/tmp/pi.jsonl': [
              createBaseEvent({ source: 'pi', timestamp: '2026-03-05T10:00:00.000Z' }),
            ],
          }),
          createAdapter('codex', {
            '/tmp/codex.jsonl': [
              createBaseEvent({
                source: 'codex',
                sessionId: 'session-2',
                timestamp: '2026-03-04T10:00:00.000Z',
              }),
            ],
          }),
        ],
      }),
    );

    expect(result.sourceSeries?.map((series) => series.source)).toEqual(['pi', 'codex']);
    expect(result.sourceSeries?.[0]?.buckets.map((bucket) => bucket.value)).toEqual([0, 15]);
    expect(result.sourceSeries?.[1]?.buckets.map((bucket) => bucket.value)).toEqual([15, 0]);
  });
});
