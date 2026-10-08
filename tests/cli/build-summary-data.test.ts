import { describe, expect, it } from 'vitest';

import {
  buildSummaryData,
  resolveMonthEnd,
  resolveSummaryWindows,
} from '../../src/cli/build-summary-data.js';
import type { SummaryPeriod } from '../../src/cli/usage-data-contracts.js';
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

function monthToDate(costUsd: number | undefined, costIncomplete?: boolean): SummaryPeriod {
  return {
    key: 'monthToDate',
    label: 'Month to date',
    since: '2026-03-01',
    until: '2026-03-10',
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      events: 0,
      activeDays: 0,
      costUsd,
      costIncomplete,
    },
    sources: [],
  };
}

describe('resolveMonthEnd', () => {
  it('scales month-to-date cost to the whole month from the third day', () => {
    expect(resolveMonthEnd('2026-03-10', monthToDate(100), undefined)).toEqual({
      daysElapsed: 10,
      daysInMonth: 31,
      projectedCostUsd: 310,
    });
    expect(resolveMonthEnd('2026-03-03', monthToDate(30, true), 50)).toEqual({
      daysElapsed: 3,
      daysInMonth: 31,
      projectedCostUsd: 310,
      costIncomplete: true,
      budgetUsd: 50,
    });
  });

  it('skips the projection in the first two days or without a cost, keeping the budget', () => {
    expect(resolveMonthEnd('2026-03-02', monthToDate(100), 50)).toEqual({
      daysElapsed: 2,
      daysInMonth: 31,
      budgetUsd: 50,
    });
    expect(resolveMonthEnd('2026-03-10', monthToDate(undefined), undefined)).toEqual({
      daysElapsed: 10,
      daysInMonth: 31,
    });
  });

  it('knows the length of February in leap and common years', () => {
    expect(resolveMonthEnd('2028-02-14', monthToDate(14), undefined)).toMatchObject({
      daysInMonth: 29,
      projectedCostUsd: 29,
    });
    expect(resolveMonthEnd('2026-02-14', monthToDate(14), undefined).daysInMonth).toBe(28);
  });
});

describe('buildSummaryData', () => {
  it('projects the month against the config budget and estimates month-to-date cache savings', async () => {
    const result = await buildSummaryData(
      { timezone: 'UTC', pricingOffline: true },
      {
        ...runtimeDeps(
          [
            createAdapter('codex', [
              // Estimated cost: priced from the bundled snapshot, which also prices the savings.
              createEvent('2026-03-05T09:00:00.000Z', {
                costMode: 'estimated',
                costUsd: undefined,
                cacheReadTokens: 1_000_000,
              }),
              // Last month: counts toward the 7-day window, not toward month-to-date savings.
              createEvent('2026-02-28T09:00:00.000Z', { cacheReadTokens: 5_000_000 }),
            ]),
          ],
          '2026-03-10T18:00:00.000Z',
        ),
        loadUserConfig: async () => ({
          config: { monthlyBudgetUsd: 25 },
          path: '/tmp/config.toml',
          exists: true,
          warnings: [],
        }),
      },
    );

    const monthToDateCost = result.periods[2]?.totals.costUsd ?? 0;
    expect(monthToDateCost).toBeGreaterThan(0);
    expect(result.monthEnd).toMatchObject({ daysElapsed: 10, daysInMonth: 31, budgetUsd: 25 });
    expect(result.monthEnd.projectedCostUsd).toBeCloseTo(monthToDateCost * 3.1, 6);
    // gpt-4.1 bundled pricing: $2.00 input vs $0.50 cache read per 1M tokens.
    expect(result.monthToDateCacheSavingsUsd).toBeCloseTo(1.5, 6);
  });

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

  it('reports streaks and activity over the past year, beyond the summary periods', async () => {
    const result = await buildSummaryData(
      { timezone: 'UTC', pricingOffline: true },
      runtimeDeps(
        [
          createAdapter('codex', [
            // Before the activity window (it starts Monday 2025-03-10).
            createEvent('2025-03-09T09:00:00.000Z'),
            // Months back: outside every summary period, inside the activity window.
            createEvent('2025-09-01T09:00:00.000Z', { totalTokens: 900 }),
            createEvent('2025-09-02T09:00:00.000Z'),
            createEvent('2025-09-03T09:00:00.000Z'),
            createEvent('2026-03-09T09:00:00.000Z'),
          ]),
        ],
        '2026-03-10T18:00:00.000Z',
      ),
    );

    expect(result.periods.map((period) => period.totals.events)).toEqual([0, 1, 1]);
    expect(result.activity).toMatchObject({
      from: '2025-03-10',
      to: '2026-03-10',
      activeDays: 4,
      currentStreak: 1,
      longestStreak: 3,
      bestDay: { date: '2025-09-01', totalTokens: 900, costUsd: 1 },
    });
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

  it('keeps config source dirs as defaults under a provider run', async () => {
    const gemini: SourceAdapter = {
      id: 'gemini',
      capabilities: { fixedProviderRoots: ['google'] },
      discoverFiles: async () => {
        throw new Error('gemini should have been pruned');
      },
      parseFile: async () => [],
    };
    const deps = {
      ...runtimeDeps(
        [gemini, createAdapter('codex', [createEvent('2026-03-10T09:00:00.000Z')])],
        '2026-03-10T18:00:00.000Z',
      ),
      loadUserConfig: async () => ({
        config: { sourceDirs: { gemini: '/tmp/config-gemini' } },
        path: '/tmp/config.toml',
        exists: true,
        warnings: [],
      }),
    };

    const result = await buildSummaryData(
      { timezone: 'UTC', pricingOffline: true, provider: 'openai' },
      deps,
    );

    expect(result.diagnostics.sourceFailures).toEqual([]);
    expect(result.diagnostics.sessionStats).toEqual([
      { source: 'codex', filesFound: 1, eventsParsed: 1 },
    ]);
  });
});
