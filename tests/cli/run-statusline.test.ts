import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSummaryData } from '../../src/cli/build-summary-data.js';
import {
  acquireStatuslineLock,
  buildStatusline,
  buildStatuslineData,
  formatStatusline,
  parseClaudeCodeSession,
  runStatusline,
  STATUSLINE_EMPTY_STORE_HINT,
} from '../../src/cli/run-statusline.js';
import type {
  SummaryDataResult,
  SummaryPeriod,
  UsageWindowTotals,
} from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { logger, setLogLevel } from '../../src/utils/logger.js';
import { readFrom } from '../helpers/fake-read.js';

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

const claudeCodeInput = JSON.stringify({
  session_id: 'abc123',
  model: { id: 'claude-opus-4-1', display_name: 'Opus' },
  cost: { total_cost_usd: 1.234 },
  context_window: { context_window_size: 200_000, used_percentage: 41.6 },
});

describe('parseClaudeCodeSession', () => {
  it("reads the session's cost and context use", () => {
    expect(parseClaudeCodeSession(claudeCodeInput)).toEqual({
      costUsd: 1.234,
      contextPercent: 41.6,
    });
  });

  it('leaves out fields Claude Code has not filled yet', () => {
    expect(
      parseClaudeCodeSession(
        JSON.stringify({ session_id: 'abc', context_window: { used_percentage: null } }),
      ),
    ).toEqual({ costUsd: undefined, contextPercent: undefined });
  });

  it.each(['', 'not json', '[]', JSON.stringify({ cost: { total_cost_usd: 1 } })])(
    'ignores input that is not a Claude Code session: %j',
    (input) => {
      expect(parseClaudeCodeSession(input)).toBeUndefined();
    },
  );
});

describe('formatStatusline', () => {
  it("shows today's cost, the streak, and month to date", () => {
    expect(formatStatusline(summary())).toBe('$12.30 today · 6d streak · ~$120.50 this month');
  });

  it("leads with the Claude Code session's cost and context use", () => {
    expect(formatStatusline(summary(), { costUsd: 1.234, contextPercent: 41.6 })).toBe(
      '$1.23 session · 42% context · $12.30 today · 6d streak · ~$120.50 this month',
    );
    expect(formatStatusline(summary(), { contextPercent: 8 })).toBe(
      '8% context · $12.30 today · 6d streak · ~$120.50 this month',
    );
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

    // No known cost this month: tokens are never set against a dollar budget.
    const unpriced = summary({
      periods: [period('today', {}), period('monthToDate', { totalTokens: 5_000 })],
      monthEnd: { daysElapsed: 10, daysInMonth: 31, budgetUsd: 500 },
    });
    expect(formatStatusline(unpriced)).toBe('0 tokens today · 6d streak · 5k tokens this month');
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
      read: readFrom(async () => [
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
      ]),
    };

    // gpt-4.1 bundled pricing: $2.00 per 1M input tokens.
    await expect(buildStatusline({ timezone: 'UTC' }, deps([adapter]))).resolves.toBe(
      '$2.00 today · 1d streak · $2.00 this month',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  function codexAdapter(events: Parameters<typeof createUsageEvent>[0][]): SourceAdapter {
    return {
      id: 'codex',
      discoverFiles: async () => ['/tmp/codex.jsonl'],
      read: readFrom(async () => events.map((event) => createUsageEvent(event))),
    };
  }

  function codexEvent(
    timestamp: string,
    overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {},
  ): Parameters<typeof createUsageEvent>[0] {
    return {
      source: 'codex',
      sessionId: 'session-1',
      timestamp,
      provider: 'openai',
      model: 'gpt-4.1',
      inputTokens: 1_000,
      outputTokens: 0,
      totalTokens: 1_000,
      ...overrides,
    };
  }

  it('counts only month-to-date events in the pricing notes, unlike the summary', async () => {
    // Mar 3: the summary's last 7 days reach back into February.
    const runDeps = {
      ...deps([
        codexAdapter([
          codexEvent('2026-03-03T09:00:00.000Z', { model: 'unpriced-model-x' }),
          codexEvent('2026-02-27T09:00:00.000Z', { model: 'unpriced-model-x' }),
        ]),
      ]),
      now: () => new Date('2026-03-03T18:00:00.000Z'),
    };

    const statusline = await buildStatuslineData({ timezone: 'UTC' }, runDeps);
    const summary = await buildSummaryData({ timezone: 'UTC', pricingOffline: true }, runDeps);

    expect(statusline.diagnostics.notes).toEqual([
      '~ marks costs that leave out 1 event with no known price (models: unpriced-model-x)',
    ]);
    expect(summary.diagnostics.notes).toEqual([
      '~ marks costs that leave out 2 events with no known price (models: unpriced-model-x)',
    ]);
  });

  it('loads prices when only events before the month need them, as the summary does', async () => {
    const resolvePricingSource = vi.fn(async () => {
      throw new Error('pricing source is down');
    });
    const runDeps = {
      ...deps([
        codexAdapter([
          // Logged costs this month need no prices; February's estimate does.
          codexEvent('2026-03-10T09:00:00.000Z', { costMode: 'explicit', costUsd: 1 }),
          codexEvent('2026-02-10T09:00:00.000Z', { costMode: 'estimated' }),
        ]),
      ]),
      resolvePricingSource,
    };

    await expect(buildStatusline({ timezone: 'UTC' }, runDeps)).rejects.toThrow(
      'pricing source is down',
    );
    await expect(
      buildSummaryData({ timezone: 'UTC', pricingOffline: true }, runDeps),
    ).rejects.toThrow('pricing source is down');

    const ignoring = { timezone: 'UTC', ignorePricingFailures: true };
    const statusline = await buildStatuslineData(ignoring, runDeps);
    const summary = await buildSummaryData({ ...ignoring, pricingOffline: true }, runDeps);

    expect(statusline.diagnostics.pricingWarning).toBe(
      'Could not load pricing; continuing without estimated costs: pricing source is down',
    );
    expect(statusline.diagnostics.pricingWarning).toBe(summary.diagnostics.pricingWarning);
    expect(formatStatusline(statusline)).toBe('$1.00 today · 1d streak · $1.00 this month');
    expect(resolvePricingSource).toHaveBeenCalledTimes(4);
  });
});

describe('acquireStatuslineLock', () => {
  async function withLockPath(run: (lockPath: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'statusline-lock-'));

    try {
      await run(path.join(dir, 'store', 'events.sqlite.statusline.lock'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('lets one tick hold the lock until it releases it', async () => {
    await withLockPath(async (lockPath) => {
      const release = await acquireStatuslineLock(lockPath, 0);
      expect(release).toBeTypeOf('function');
      await expect(acquireStatuslineLock(lockPath, 100)).resolves.toBeUndefined();

      await release?.();
      const next = await acquireStatuslineLock(lockPath, 0);
      expect(next).toBeTypeOf('function');
      await next?.();
    });
  });

  it('takes over a lock left by an exited process or held too long', async () => {
    await withLockPath(async (lockPath) => {
      const exited = spawnSync(process.execPath, ['-e', '']);
      await acquireStatuslineLock(lockPath, 0);
      await writeFile(lockPath, String(exited.pid));
      const afterExit = await acquireStatuslineLock(lockPath, 0);
      expect(afterExit).toBeTypeOf('function');
      await expect(readFile(lockPath, 'utf8')).resolves.toBe(String(process.pid));

      // Still this process's lock, but ten minutes old.
      const longAgo = new Date(Date.now() - 600_000);
      await utimes(lockPath, longAgo, longAgo);
      await expect(acquireStatuslineLock(lockPath, 0)).resolves.toBeTypeOf('function');
    });
  });

  it('leaves a lock another tick took over in place on release', async () => {
    await withLockPath(async (lockPath) => {
      const release = await acquireStatuslineLock(lockPath, 0);
      await writeFile(lockPath, '1');
      await release?.();
      await expect(readFile(lockPath, 'utf8')).resolves.toBe('1');
    });
  });
});

describe('runStatusline', () => {
  it('prints one line on stdout and silences stderr diagnostics', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'statusline-run-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runStatusline(
        { source: 'codex', codexDir: emptyDir, timezone: 'UTC' },
        { stdin: Readable.from([]) },
      );

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(String(logSpy.mock.calls[0]?.[0])).toMatch(/ today · .* this month$/u);
      expect(errorSpy).not.toHaveBeenCalled();
      logger.warn('after the run');
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      // The module default; runStatusline lowers it for the whole process.
      setLogLevel('info');
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('adds the session from Claude Code input, and finishes when stdin stays open', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'statusline-stdin-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const openPipe = new PassThrough();

    try {
      const options = { source: 'codex', codexDir: emptyDir, timezone: 'UTC' };
      await runStatusline(options, { stdin: Readable.from([Buffer.from(claudeCodeInput)]) });
      await runStatusline(options, { stdin: openPipe });

      const lines = logSpy.mock.calls.map(([line]) => String(line));
      expect(lines[0]).toMatch(/^\$1\.23 session · 42% context · .* today/u);
      expect(lines[1]).toMatch(/^\S+ today/u);
      expect(openPipe.destroyed).toBe(true);
    } finally {
      setLogLevel('info');
      logSpy.mockRestore();
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('prints the run diagnostics on stderr with --verbose', async () => {
    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'statusline-verbose-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      // The CLI's preAction hook raises the level for --verbose; mirror it here.
      setLogLevel('debug');
      await runStatusline(
        { source: 'codex', codexDir: emptyDir, timezone: 'UTC', verbose: true },
        { stdin: Readable.from([]) },
      );

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('No session files found');
    } finally {
      setLogLevel('info');
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('prints a warming-up line while another tick holds the lock', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'statusline-locked-'));
    const storePath = path.join(dir, 'events.sqlite');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', storePath);
    const release = await acquireStatuslineLock(`${storePath}.statusline.lock`, 0);

    try {
      await runStatusline(
        { source: 'codex', codexDir: dir, timezone: 'UTC' },
        { stdin: Readable.from([Buffer.from(claudeCodeInput)]) },
      );

      expect(logSpy.mock.calls).toEqual([['$1.23 session · 42% context · warming up…']]);
    } finally {
      await release?.();
      vi.unstubAllEnvs();
      setLogLevel('info');
      logSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hints once per event store on stderr when there is no usage at all', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'statusline-empty-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(dir, 'events.sqlite'));

    try {
      const options = { source: 'codex', codexDir: dir, timezone: 'UTC' };
      await runStatusline(options, { stdin: Readable.from([]) });
      await runStatusline(options, { stdin: Readable.from([]) });

      expect(stderrSpy.mock.calls).toEqual([[`${STATUSLINE_EMPTY_STORE_HINT}\n`]]);
      expect(logSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
      setLogLevel('info');
      logSpy.mockRestore();
      stderrSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
