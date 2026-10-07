import { describe, expect, it } from 'vitest';

import { buildSummaryData, resolveSummaryWindows } from '../../src/cli/build-summary-data.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

function createAdapter(
  id: SourceAdapter['id'],
  events: ReturnType<typeof createUsageEvent>[],
): SourceAdapter {
  return {
    id,
    discoverFiles: async () => [`/tmp/${id}.jsonl`],
    parseFile: async () => events,
  };
}

function createEvent(
  timestamp: string,
  overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {},
) {
  return createUsageEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp,
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    costMode: 'explicit',
    costUsd: 1,
    ...overrides,
  });
}

function runtimeDeps(adapters: SourceAdapter[], now: string) {
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
    createAdapters: () => adapters,
    now: () => new Date(now),
  };
}

describe('resolveSummaryWindows', () => {
  it('resolves today, the last 7 days, and month to date in the report timezone', () => {
    // 23:30 UTC on Mar 3 is already Mar 4 in Paris.
    const windows = resolveSummaryWindows('Europe/Paris', new Date('2026-03-03T23:30:00.000Z'));

    expect(windows).toEqual([
      { key: 'today', label: 'Today', since: '2026-03-04', until: '2026-03-04' },
      { key: 'last7Days', label: 'Last 7 days', since: '2026-02-26', until: '2026-03-04' },
      { key: 'monthToDate', label: 'Month to date', since: '2026-03-01', until: '2026-03-04' },
    ]);
  });
});

describe('buildSummaryData', () => {
  it('sums each period and ranks its sources by cost', async () => {
    const codexEvents = [
      createEvent('2026-03-10T09:00:00.000Z'),
      createEvent('2026-03-08T09:00:00.000Z'),
      createEvent('2026-03-02T09:00:00.000Z'),
      // Last month: inside the 7-day window only.
      createEvent('2026-02-28T09:00:00.000Z', { costUsd: 0.5 }),
    ];
    const claudeEvents = [
      createEvent('2026-03-10T10:00:00.000Z', {
        source: 'claude',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        costUsd: 4,
      }),
    ];

    const result = await buildSummaryData(
      { timezone: 'UTC', pricingOffline: true },
      runtimeDeps(
        [createAdapter('codex', codexEvents), createAdapter('claude', claudeEvents)],
        '2026-03-10T18:00:00.000Z',
      ),
    );

    const summary = result.periods.map((period) => ({
      key: period.key,
      since: period.since,
      events: period.totals.events,
      costUsd: period.totals.costUsd,
      activeDays: period.totals.activeDays,
      sources: period.sources.map((source) => [source.source, source.costUsd]),
    }));

    expect(result.timezone).toBe('UTC');
    expect(summary).toEqual([
      {
        key: 'today',
        since: '2026-03-10',
        events: 2,
        costUsd: 5,
        activeDays: 1,
        sources: [
          ['claude', 4],
          ['codex', 1],
        ],
      },
      {
        key: 'last7Days',
        since: '2026-03-04',
        events: 3,
        costUsd: 6,
        activeDays: 2,
        sources: [
          ['claude', 4],
          ['codex', 2],
        ],
      },
      {
        key: 'monthToDate',
        since: '2026-03-01',
        events: 4,
        costUsd: 7,
        activeDays: 3,
        sources: [
          ['claude', 4],
          ['codex', 3],
        ],
      },
    ]);
  });

  it('covers the last days of the previous month early in a month', async () => {
    const result = await buildSummaryData(
      { timezone: 'UTC', pricingOffline: true },
      runtimeDeps(
        [createAdapter('codex', [createEvent('2026-02-27T09:00:00.000Z')])],
        '2026-03-02T09:00:00.000Z',
      ),
    );

    expect(result.periods.map((period) => [period.key, period.totals.events])).toEqual([
      ['today', 0],
      ['last7Days', 1],
      ['monthToDate', 0],
    ]);
  });

  it('breaks source cost ties by tokens, then by source id', async () => {
    const result = await buildSummaryData(
      { timezone: 'UTC', pricingOffline: true },
      runtimeDeps(
        [
          createAdapter('pi', [
            createEvent('2026-03-10T09:00:00.000Z', { source: 'pi', totalTokens: 15 }),
          ]),
          createAdapter('codex', [createEvent('2026-03-10T09:00:00.000Z', { totalTokens: 15 })]),
          createAdapter('gemini', [
            createEvent('2026-03-10T09:00:00.000Z', {
              source: 'gemini',
              inputTokens: 100,
              totalTokens: 105,
            }),
          ]),
        ],
        '2026-03-10T18:00:00.000Z',
      ),
    );

    expect(result.periods[0]?.sources.map((source) => source.source)).toEqual([
      'gemini',
      'codex',
      'pi',
    ]);
  });
});
