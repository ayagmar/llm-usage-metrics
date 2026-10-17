import { describe, expect, it, vi } from 'vitest';

import { buildTrendsData } from '../../src/cli/build-trends-data.js';
import type { PricingLoadResult } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { createDefaultOpenAiPricingSource } from '../helpers/static-pricing-source.js';
import { shiftLocalDateKey } from '../../src/utils/time-buckets.js';
import { readFrom } from '../helpers/fake-read.js';

function createAdapter(
  id: SourceAdapter['id'],
  eventsByFile: Record<string, ReturnType<typeof createUsageEvent>[]>,
): SourceAdapter {
  const files = Object.keys(eventsByFile);

  return {
    id,
    discoverFiles: async () => files,
    read: readFrom(async (filePath) => eventsByFile[filePath] ?? []),
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

  it('uses explicit trailing day ranges when --last is provided', async () => {
    const result = await buildTrendsData(
      {
        metric: 'tokens',
        last: '3',
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

  it('accepts --days as an alias of --last', async () => {
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

  it('rejects --last beyond the 10000-day cap shared with usage reports', async () => {
    await expect(buildTrendsData({ last: '10001' }, runtimeDeps())).rejects.toThrow(
      '--last must be a whole number from 1 to 10000',
    );
  });

  it('names --days in errors when the alias was passed', async () => {
    await expect(
      buildTrendsData({ days: '7', since: '2026-03-01' }, runtimeDeps()),
    ).rejects.toThrow('--days cannot be combined with --since or --until');
    await expect(buildTrendsData({ days: '0' }, runtimeDeps())).rejects.toThrow(
      '--days must be a whole number from 1 to 10000',
    );
  });

  it('rejects passing both --last and its --days alias', async () => {
    await expect(buildTrendsData({ last: '7', days: '7' }, runtimeDeps())).rejects.toThrow(
      '--days is an alias of --last; pass only --last',
    );
  });

  it('rejects --last when combined with explicit date flags', async () => {
    await expect(
      buildTrendsData(
        {
          last: '7',
          since: '2026-03-01',
        },
        runtimeDeps(),
      ),
    ).rejects.toThrow('--last cannot be combined with --since or --until');
  });

  it('rejects invalid days, metric, and date ordering inputs', async () => {
    await expect(
      buildTrendsData(
        {
          last: '0',
        },
        runtimeDeps(),
      ),
    ).rejects.toThrow('--last must be a whole number from 1 to 10000');

    await expect(
      buildTrendsData(
        {
          metric: 'latency',
        },
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

  it('marks cost spikes against the 28 days before the chart, which it does not show', async () => {
    // $2 a day from Feb 6 (28 days before the chart) to Mar 5. In the chart, $5 is under 3x
    // that median, $6 is not.
    const costOn = (date: string, costUsd: number, repoRoot?: string) =>
      createBaseEvent({
        timestamp: `${date}T10:00:00.000Z`,
        costMode: 'explicit',
        costUsd,
        repoRoot,
      });
    const result = await buildTrendsData(
      { last: '2', byRepo: true },
      runtimeDeps({
        now: () => new Date('2026-03-07T12:00:00.000Z'),
        adapters: [
          createAdapter('pi', {
            '/tmp/a.jsonl': [
              ...Array.from({ length: 28 }, (_, index) =>
                costOn(shiftLocalDateKey('2026-02-06', index), 2),
              ),
              // A project with the same folder name, before the chart only.
              costOn('2026-02-10', 1, '/old/app'),
              costOn('2026-03-06', 5, '/work/app'),
              costOn('2026-03-07', 6, '/work/app'),
            ],
          }),
        ],
      }),
    );

    expect(result.totalSeries.buckets.map((bucket) => [bucket.date, bucket.spike])).toEqual([
      ['2026-03-06', undefined],
      ['2026-03-07', true],
    ]);
    expect(result.totalSeries.summary.total).toBe(11);
    expect(result.projectSeries?.map((series) => series.project)).toEqual(['app']);
  });

  it('picks the --model rule from the chart, not from the spike lookback days', async () => {
    // The exact name appears only before the chart; inside it, only a dated variant does.
    const adapters = [
      createAdapter('pi', {
        '/tmp/a.jsonl': [
          createBaseEvent({
            timestamp: '2026-10-01T10:00:00.000Z',
            model: 'claude-opus-4-1',
            costMode: 'explicit',
            costUsd: 1,
          }),
          createBaseEvent({
            timestamp: '2026-10-16T10:00:00.000Z',
            model: 'claude-opus-4-1-20250805',
            costMode: 'explicit',
            costUsd: 2,
          }),
        ],
      }),
    ];
    const now = () => new Date('2026-10-17T12:00:00.000Z');
    const chart = async (metric: string) =>
      (
        await buildTrendsData(
          { metric, last: '3', model: ['claude-opus-4-1'] },
          runtimeDeps({ now, adapters }),
        )
      ).totalSeries.buckets.map((bucket) => [bucket.date, bucket.value]);

    expect(await chart('cost')).toEqual([
      ['2026-10-15', 0],
      ['2026-10-16', 2],
      ['2026-10-17', 0],
    ]);
    expect(await chart('tokens')).toEqual([
      ['2026-10-15', 0],
      ['2026-10-16', 15],
      ['2026-10-17', 0],
    ]);
  });

  it('marks no spikes on token trends', async () => {
    const result = await buildTrendsData(
      { metric: 'tokens', last: '1' },
      runtimeDeps({
        now: () => new Date('2026-03-07T12:00:00.000Z'),
        adapters: [
          createAdapter('pi', {
            '/tmp/a.jsonl': [
              createBaseEvent({
                timestamp: '2026-03-07T10:00:00.000Z',
                costMode: 'explicit',
                costUsd: 50,
              }),
            ],
          }),
        ],
      }),
    );

    expect(result.totalSeries.buckets[0]?.spike).toBeUndefined();
  });
});
