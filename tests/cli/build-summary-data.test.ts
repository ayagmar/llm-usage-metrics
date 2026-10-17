import { describe, expect, it } from 'vitest';

import {
  buildSummaryData,
  resolveMonthEnd,
  resolveSummaryWindows,
} from '../../src/cli/build-summary-data.js';
import type { SummaryPeriod } from '../../src/cli/usage-data-contracts.js';
import {
  createWindowEventFilter,
  isEventWithinWindow,
} from '../../src/cli/usage-window-summary.js';
import { createDateWindowPrefilter } from '../../src/cli/parse/usage-event-filters.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { renderSummaryReport } from '../../src/render/render-summary-report.js';
import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { readFrom } from '../helpers/fake-read.js';

function createAdapter(
  id: SourceAdapter['id'],
  events: ReturnType<typeof createUsageEvent>[],
  capabilities?: SourceAdapter['capabilities'],
): SourceAdapter {
  return {
    id,
    capabilities,
    discoverFiles: async () => [`/tmp/${id}.jsonl`],
    read: readFrom(async () => events),
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

describe('createWindowEventFilter', () => {
  it('keeps the events whose local date is in the window, in every offset', () => {
    const timezones = [
      'UTC',
      'Pacific/Kiritimati',
      'Pacific/Pago_Pago',
      'Asia/Kolkata',
      'Asia/Kathmandu',
      'America/St_Johns',
      'Australia/Lord_Howe',
      'Europe/Paris',
    ];
    const windows = [
      { since: '2026-03-29', until: '2026-03-29' },
      { since: '2026-03-01', until: '2026-03-31' },
      { since: '2025-12-30', until: '2026-01-02' },
    ];
    // Every 7 minutes from 3 days before to 3 days after each window, plus timestamps in
    // other shapes. `createUsageEvent` stores the canonical form, so those are spread over a
    // created event, as a stored event built elsewhere can carry them.
    const nonCanonicalTimestamps = windows.flatMap((window) => [
      `${window.since}T00:30:00Z`,
      `${window.since}T00:30:00+00:00`,
      // The day before `since` in UTC, read as `since` by its text.
      `${window.since}T00:30:00+14:00`,
      // The day after `until` in UTC, read as `until` by its text.
      `${window.until}T23:30:00-11:00`,
    ]);
    const events = [
      ...windows.flatMap((window) => {
        const from = Date.parse(`${window.since}T00:00:00.000Z`) - 3 * 86_400_000;
        const to = Date.parse(`${window.until}T00:00:00.000Z`) + 4 * 86_400_000;
        const timestamps: string[] = [];

        for (let time = from; time < to; time += 7 * 60_000) {
          timestamps.push(new Date(time).toISOString());
        }

        return timestamps.map((timestamp) =>
          createEvent('2026-03-05T09:00:00.000Z', { timestamp }),
        );
      }),
      ...nonCanonicalTimestamps.map((timestamp) => ({
        ...createEvent('2026-03-05T09:00:00.000Z'),
        timestamp,
      })),
    ];

    // Those shapes skip the text comparison and are converted to a local date.
    for (const window of windows) {
      const prefilterDate = createDateWindowPrefilter(window.since, window.until);

      for (const timestamp of nonCanonicalTimestamps) {
        expect(prefilterDate(timestamp), timestamp).toBe('near-edge');
      }
    }

    const utcSingleDay = createWindowEventFilter(windows[0], 'UTC');
    expect(utcSingleDay({ ...events[0], timestamp: '2026-03-29T00:30:00+00:00' })).toBe(true);
    expect(utcSingleDay({ ...events[0], timestamp: '2026-03-29T00:30:00+14:00' })).toBe(false);
    expect(utcSingleDay({ ...events[0], timestamp: '2026-03-29T23:30:00-11:00' })).toBe(false);

    for (const timezone of timezones) {
      for (const window of windows) {
        const isInWindow = createWindowEventFilter(window, timezone);
        const mismatches = events.filter(
          (event) => isInWindow(event) !== isEventWithinWindow(event, window, timezone),
        );

        expect(mismatches, `${timezone} ${window.since}..${window.until}`).toEqual([]);
      }
    }
  });
});

function monthToDate(
  costUsd: number | undefined,
  costIncomplete?: boolean,
  events = 3,
): SummaryPeriod {
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
      events,
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
    // An empty month has a zero cost, not a $0.00 pace.
    expect(resolveMonthEnd('2026-03-10', monthToDate(0, false, 0), 50)).toEqual({
      daysElapsed: 10,
      daysInMonth: 31,
      budgetUsd: 50,
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
  it('drops the budget when CLI filters narrow the run, but not for config sources', async () => {
    const run = (options: Parameters<typeof buildSummaryData>[0], sources?: string[]) =>
      buildSummaryData(
        { timezone: 'UTC', pricingOffline: true, ...options },
        {
          ...runtimeDeps(
            [createAdapter('codex', [createEvent('2026-03-05T09:00:00.000Z')])],
            '2026-03-10T18:00:00.000Z',
          ),
          loadUserConfig: async () => ({
            config: { monthlyBudgetUsd: 25, sources },
            path: '/tmp/config.toml',
            exists: true,
            warnings: [],
          }),
        },
      );

    expect((await run({})).monthEnd.budgetUsd).toBe(25);
    expect((await run({}, ['codex'])).monthEnd.budgetUsd).toBe(25);
    expect((await run({ source: 'codex' })).monthEnd.budgetUsd).toBeUndefined();
    expect((await run({ provider: 'openai' })).monthEnd.budgetUsd).toBeUndefined();
    expect((await run({ model: ['gpt-4.1'] })).monthEnd.budgetUsd).toBeUndefined();

    // One project is not measured against the whole budget, even when it holds all usage.
    const oneProject = await run({ repo: ['(unattributed)'] });
    expect(oneProject.periods.find((period) => period.key === 'monthToDate')?.totals.events).toBe(
      1,
    );
    expect(oneProject.monthEnd.budgetUsd).toBeUndefined();
    expect(renderSummaryReport(oneProject, 'terminal')).not.toContain('budget');
    expect(renderSummaryReport(await run({}), 'terminal')).toContain('budget');
  });

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

  it('estimates cache savings at long-context rates for a per-request source', async () => {
    const run = (capabilities?: SourceAdapter['capabilities']) =>
      buildSummaryData(
        { timezone: 'UTC', pricingOffline: true },
        runtimeDeps(
          [
            createAdapter(
              'codex',
              [
                createEvent('2026-03-05T09:00:00.000Z', {
                  model: 'gpt-5.4',
                  costMode: 'estimated',
                  costUsd: undefined,
                  cacheReadTokens: 300_000,
                }),
              ],
              capabilities,
            ),
          ],
          '2026-03-10T18:00:00.000Z',
        ),
      );

    // gpt-5.4 bundled pricing above 272k prompt tokens: $5.00 input vs $0.50 cache read per
    // 1M; at the base rates, $2.50 vs $0.25.
    expect((await run({ usagePerRequest: true })).monthToDateCacheSavingsUsd).toBeCloseTo(1.35, 6);
    expect((await run()).monthToDateCacheSavingsUsd).toBeCloseTo(0.675, 6);
  });

  it('still estimates cache savings under --cost-mode explicit, without pricing unlogged events', async () => {
    const result = await buildSummaryData(
      { timezone: 'UTC', pricingOffline: true, costMode: 'explicit' },
      runtimeDeps(
        [
          createAdapter('codex', [
            createEvent('2026-03-05T09:00:00.000Z', {
              costMode: 'estimated',
              costUsd: undefined,
              cacheReadTokens: 1_000_000,
            }),
          ]),
        ],
        '2026-03-10T18:00:00.000Z',
      ),
    );

    expect(result.periods[2]?.totals.costUsd).toBeUndefined();
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

  it('compares each period with the same number of local days just before it', async () => {
    const result = await buildSummaryData(
      { timezone: 'Europe/Paris', pricingOffline: true },
      runtimeDeps(
        [
          createAdapter('codex', [
            // 00:30 on Mar 9 in Paris: yesterday.
            createEvent('2026-03-08T23:30:00.000Z', { costUsd: 1 }),
            // 00:30 on Mar 10 in Paris: today, so in no previous period.
            createEvent('2026-03-09T23:30:00.000Z', { costUsd: 100 }),
            createEvent('2026-03-03T09:00:00.000Z', { costUsd: 2 }),
            createEvent('2026-02-25T09:00:00.000Z', { costUsd: 4 }),
            createEvent('2026-02-19T09:00:00.000Z', { costUsd: 8 }),
            // One day before the month-to-date's previous period.
            createEvent('2026-02-18T09:00:00.000Z', { costUsd: 16 }),
          ]),
        ],
        '2026-03-10T18:00:00.000Z',
      ),
    );

    expect(
      result.periods.map((period) => ({
        key: period.key,
        since: period.previous?.since,
        until: period.previous?.until,
        costUsd: period.previous?.totals.costUsd,
        events: period.previous?.totals.events,
      })),
    ).toEqual([
      { key: 'today', since: '2026-03-09', until: '2026-03-09', costUsd: 1, events: 1 },
      { key: 'last7Days', since: '2026-02-25', until: '2026-03-03', costUsd: 6, events: 2 },
      { key: 'monthToDate', since: '2026-02-19', until: '2026-02-28', costUsd: 12, events: 2 },
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
      read: readFrom(async () => []),
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
