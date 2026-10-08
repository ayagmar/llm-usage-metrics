import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildStatusline, formatStatusline, runStatusline } from '../../src/cli/run-statusline.js';
import type {
  SummaryDataResult,
  SummaryPeriod,
  UsageWindowTotals,
} from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';
import { setLogLevel } from '../../src/utils/logger.js';

function totals(overrides: Partial<UsageWindowTotals> = {}): UsageWindowTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    events: 0,
    activeDays: 0,
    ...overrides,
  };
}

function period(key: SummaryPeriod['key'], overrides: Partial<UsageWindowTotals>): SummaryPeriod {
  return {
    key,
    label: key,
    since: '2026-03-01',
    until: '2026-03-10',
    totals: totals(overrides),
    sources: [],
  };
}

function summary(overrides: Partial<SummaryDataResult> = {}): SummaryDataResult {
  return {
    timezone: 'UTC',
    periods: [
      period('today', { costUsd: 12.3, totalTokens: 1_000 }),
      period('last7Days', { costUsd: 50, totalTokens: 9_000 }),
      period('monthToDate', { costUsd: 120.5, costIncomplete: true, totalTokens: 20_000 }),
    ],
    monthEnd: { daysElapsed: 10, daysInMonth: 31, projectedCostUsd: 373.55, costIncomplete: true },
    activity: {
      from: '2025-03-10',
      to: '2026-03-10',
      activeDays: 6,
      currentStreak: 6,
      longestStreak: 6,
      days: [],
    },
    diagnostics: {
      sessionStats: [],
      sourceFailures: [],
      skippedRows: [],
      pricingOrigin: 'none',
      activeEnvOverrides: [],
      timezone: 'UTC',
    },
    ...overrides,
  };
}

describe('formatStatusline', () => {
  it("shows today's cost, the streak, and month to date", () => {
    expect(formatStatusline(summary())).toBe('$12.30 today · 6d streak · ~$120.50 this month');
  });

  it('drops a zero streak and falls back to tokens when a cost is unknown', () => {
    const data = summary({
      activity: { ...summary().activity, currentStreak: 0 },
      periods: [period('today', { totalTokens: 1_500_000 }), period('monthToDate', {})],
    });

    expect(formatStatusline(data)).toBe('1.5M tokens today · 0 tokens this month');
  });

  it('shows the budget and flags a month over pace or over budget', () => {
    const within = summary({
      monthEnd: { daysElapsed: 10, daysInMonth: 31, projectedCostUsd: 373.55, budgetUsd: 500 },
    });
    const overPace = summary({
      monthEnd: { daysElapsed: 10, daysInMonth: 31, projectedCostUsd: 373.55, budgetUsd: 300 },
    });
    // Day 2: no projection yet, but spending already passed the budget.
    const overSpent = summary({ monthEnd: { daysElapsed: 2, daysInMonth: 31, budgetUsd: 100 } });

    expect(formatStatusline(within)).toBe('$12.30 today · 6d streak · ~$120.50/$500.00 this month');
    expect(formatStatusline(overPace)).toBe(
      '$12.30 today · 6d streak · ~$120.50/$300.00 this month ⚠',
    );
    expect(formatStatusline(overSpent)).toMatch(/\/\$100\.00 this month ⚠$/u);
  });
});

describe('buildStatusline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function deps(adapters: SourceAdapter[]) {
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
      loadUserConfig: async () => ({
        config: {},
        path: '/tmp/config.toml',
        exists: false,
        warnings: [],
      }),
      now: () => new Date('2026-03-10T18:00:00.000Z'),
    };
  }

  it('prices events without ever fetching', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('statusline must not fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const adapter: SourceAdapter = {
      id: 'codex',
      discoverFiles: async () => ['/tmp/codex.jsonl'],
      parseFile: async () => [
        createUsageEvent({
          source: 'codex',
          sessionId: 'session-1',
          timestamp: '2026-03-10T09:00:00.000Z',
          provider: 'openai',
          model: 'gpt-4.1',
          inputTokens: 1_000_000,
          outputTokens: 0,
          totalTokens: 1_000_000,
          costMode: 'estimated',
        }),
      ],
    };

    // gpt-4.1 bundled pricing: $2.00 per 1M input tokens.
    await expect(buildStatusline({ timezone: 'UTC' }, deps([adapter]))).resolves.toBe(
      '$2.00 today · 1d streak · $2.00 this month',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects --json with a pointer to summary --json', async () => {
    await expect(buildStatusline({ json: true }, deps([]))).rejects.toThrow(
      '--json is not supported for statusline; use llm-usage summary --json',
    );
  });
});

describe('runStatusline', () => {
  it('prints one line on stdout and silences stderr diagnostics', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'statusline-run-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runStatusline({ source: 'codex', codexDir: emptyDir, timezone: 'UTC' });

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(String(logSpy.mock.calls[0]?.[0])).toMatch(/ today · .* this month$/u);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      // The module default; runStatusline lowers it for the whole process.
      setLogLevel('info');
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});
