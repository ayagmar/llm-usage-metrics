import { spawnSync } from 'node:child_process';
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

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
import { resolveStatuslineCacheKey, STATUSLINE_REUSE_MS } from '../../src/cli/statusline-cache.js';
import type {
  SummaryDataResult,
  SummaryPeriod,
  UsageWindowTotals,
} from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { logger, setLogLevel } from '../../src/utils/logger.js';
import { readFrom } from '../helpers/fake-read.js';

const fsHooks = vi.hoisted(() => ({
  /** Runs once, after the next `readFile` call reads its file. */
  afterReadFile: undefined as (() => Promise<void>) | undefined,
  /** Makes `writeFile` fail on the next handle `open` returns, and records that handle. */
  failNextHandleWrite: false,
  failedHandle: undefined as FsPromises.FileHandle | undefined,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
  const readFile = async (...args: Parameters<typeof actual.readFile>) => {
    const content = await actual.readFile(...args);
    const hook = fsHooks.afterReadFile;
    fsHooks.afterReadFile = undefined;
    await hook?.();
    return content;
  };

  const open = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);

    if (fsHooks.failNextHandleWrite) {
      fsHooks.failNextHandleWrite = false;
      fsHooks.failedHandle = handle;
      handle.writeFile = () => Promise.reject(new Error('no space left on device'));
    }

    return handle;
  };

  return { ...actual, open, readFile };
});

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
      await expect(readFile(lockPath, 'utf8')).resolves.toMatch(`${String(process.pid)} `);

      // Still this process's lock, but ten minutes old.
      const longAgo = new Date(Date.now() - 600_000);
      await utimes(lockPath, longAgo, longAgo);
      await expect(acquireStatuslineLock(lockPath, 0)).resolves.toBeTypeOf('function');
    });
  });

  it('lets only one of two ticks reclaiming the same stale lock through', async () => {
    await withLockPath(async (lockPath) => {
      await acquireStatuslineLock(lockPath, 0);
      const longAgo = new Date(Date.now() - 600_000);
      await utimes(lockPath, longAgo, longAgo);

      // The second tick reads the stale lock, then the first takes it over before the
      // second acts on what it read.
      let first: (() => Promise<void>) | undefined;
      fsHooks.afterReadFile = async () => {
        first = await acquireStatuslineLock(lockPath, 0);
      };
      const second = await acquireStatuslineLock(lockPath, 0);

      expect(first).toBeTypeOf('function');
      expect(second).toBeUndefined();
      await first?.();
      await expect(readdir(path.dirname(lockPath))).resolves.toEqual([]);
    });
  });

  it('keeps a lock another tick took over held while the old holder releases', async () => {
    await withLockPath(async (lockPath) => {
      // A held the lock past the stale age and B took it over while A still ran.
      const releaseA = await acquireStatuslineLock(lockPath, 0);
      const longAgo = new Date(Date.now() - 600_000);
      await utimes(lockPath, longAgo, longAgo);
      const releaseB = await acquireStatuslineLock(lockPath, 0);
      const lockB = await readFile(lockPath, 'utf8');

      // C starts while A releases.
      let releaseC: (() => Promise<void>) | undefined;
      fsHooks.afterReadFile = async () => {
        releaseC = await acquireStatuslineLock(lockPath, 0);
      };
      await releaseA?.();

      expect(releaseC).toBeUndefined();
      await expect(readFile(lockPath, 'utf8')).resolves.toBe(lockB);
      await releaseB?.();
    });
  });

  it('leaves no lock and no open handle when writing the token fails', async () => {
    await withLockPath(async (lockPath) => {
      fsHooks.failNextHandleWrite = true;
      await acquireStatuslineLock(lockPath, 0);

      expect(fsHooks.failedHandle?.fd).toBe(-1);
      await expect(readdir(path.dirname(lockPath))).resolves.toEqual([]);
    });
  });

  it('leaves a lock another tick took over in place on release', async () => {
    await withLockPath(async (lockPath) => {
      // Held past the stale age, so another tick takes it over while this one still runs.
      const release = await acquireStatuslineLock(lockPath, 0);
      const longAgo = new Date(Date.now() - 600_000);
      await utimes(lockPath, longAgo, longAgo);
      const next = await acquireStatuslineLock(lockPath, 0);
      const nextLock = await readFile(lockPath, 'utf8');

      await release?.();
      await expect(readFile(lockPath, 'utf8')).resolves.toBe(nextLock);
      await expect(acquireStatuslineLock(lockPath, 0)).resolves.toBeUndefined();
      await next?.();
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

  describe('with a line built by an earlier tick', () => {
    const builtAt = new Date('2026-06-15T12:00:00.000Z');
    const at = (ms: number) => () => new Date(builtAt.getTime() + ms);
    const noInput = () => Readable.from([]);
    let dir: string;
    let storePath: string;
    let logSpy: MockInstance<typeof console.log>;
    let lines: () => string[];

    /** One billed-looking codex day, so a new file changes the line. */
    async function writeCodexSession(name: string): Promise<void> {
      await writeFile(
        path.join(dir, `${name}.jsonl`),
        [
          { timestamp: '2026-06-15T10:00:00.000Z', type: 'session_meta', payload: { id: name } },
          {
            timestamp: '2026-06-15T10:00:00.000Z',
            type: 'turn_context',
            payload: { model: 'gpt-5.2' },
          },
          {
            timestamp: '2026-06-15T10:00:01.000Z',
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: {
                  input_tokens: 1_000_000,
                  output_tokens: 100_000,
                  total_tokens: 1_100_000,
                },
              },
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n'),
      );
    }

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'statusline-reuse-'));
      storePath = path.join(dir, 'store', 'events.sqlite');
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      lines = () => logSpy.mock.calls.map(([line]) => String(line));
      vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
      vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', storePath);
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      setLogLevel('info');
      logSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    });

    const options = () => ({ source: 'codex', codexDir: dir, timezone: 'UTC' });

    it('reuses a recent line, with this tick session, then rebuilds it', async () => {
      await writeCodexSession('first');
      await runStatusline(options(), { stdin: noInput(), now: at(0) });
      await writeCodexSession('second');

      await runStatusline(options(), {
        stdin: Readable.from([Buffer.from(claudeCodeInput)]),
        now: at(STATUSLINE_REUSE_MS - 1),
      });
      await runStatusline(options(), { stdin: noInput(), now: at(STATUSLINE_REUSE_MS) });

      const [built, reused, rebuilt] = lines();
      expect(reused).toBe(`$1.23 session · 42% context · ${built}`);
      expect(rebuilt).not.toBe(built);
    });

    it('shows the stored line, without waiting, while another tick builds the next', async () => {
      await writeCodexSession('first');
      await runStatusline(options(), { stdin: noInput(), now: at(0) });
      const release = await acquireStatuslineLock(`${storePath}.statusline.lock`, 0);

      try {
        const startedAt = Date.now();
        await runStatusline(options(), { stdin: noInput(), now: at(STATUSLINE_REUSE_MS) });

        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(lines()[1]).toBe(lines()[0]);
      } finally {
        await release?.();
      }
    });

    it.each([
      ['another day', { now: at(24 * 60 * 60 * 1000) }, {}],
      ['other options', { now: at(1) }, { source: 'codex', codexDir: `${path.sep}elsewhere` }],
    ])('never shows a stored line for %s', async (_label, deps, overrides) => {
      await writeCodexSession('first');
      await runStatusline(options(), { stdin: noInput(), now: at(0) });
      const release = await acquireStatuslineLock(`${storePath}.statusline.lock`, 0);

      try {
        await runStatusline({ ...options(), ...overrides }, { stdin: noInput(), ...deps });

        expect(lines()[1]).toBe('warming up…');
      } finally {
        await release?.();
      }
    });

    it('reuses the line the holder stored while this tick waited', async () => {
      const cachePath = `${storePath}.statusline.json`;
      await writeCodexSession('first');
      await runStatusline(options(), { stdin: noInput(), now: at(0) });
      const storedLine = await readFile(cachePath, 'utf8');
      await rm(cachePath);
      await writeCodexSession('second');
      const release = await acquireStatuslineLock(`${storePath}.statusline.lock`, 0);

      const waiting = runStatusline(options(), { stdin: noInput(), now: at(1) });
      await writeFile(cachePath, storedLine);
      await release?.();
      await waiting;

      expect(lines()[1]).toBe(lines()[0]);
    });

    it('keys a line on what it covers, and shares it across project directories', () => {
      const key = (flags: object = {}) => resolveStatuslineCacheKey(flags, {});
      const cwd = vi.spyOn(process, 'cwd');

      try {
        cwd.mockReturnValue(path.join(dir, 'a'));
        const plain = key();
        const relative = key({ codexDir: './logs' });
        cwd.mockReturnValue(path.join(dir, 'b'));

        expect(key()).toBe(plain);
        expect(key({ codexDir: './logs' })).not.toBe(relative);
        vi.stubEnv('XDG_DATA_HOME', path.join(dir, 'data'));
        expect(key()).not.toBe(plain);
        vi.unstubAllEnvs();
        vi.stubEnv('XDG_CACHE_HOME', path.join(dir, 'prices'));
        expect(key()).not.toBe(plain);
        vi.unstubAllEnvs();
        vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
        const absoluteHome = key();
        cwd.mockReturnValue(path.join(dir, 'a'));
        expect(key()).toBe(absoluteHome);
        vi.stubEnv('CODEX_HOME', '.codex');
        const relativeHome = key();
        cwd.mockReturnValue(path.join(dir, 'b'));
        expect(key()).not.toBe(relativeHome);
        vi.unstubAllEnvs();
        vi.stubEnv('TZ', 'Pacific/Auckland');
        const auckland = key();
        vi.stubEnv('TZ', 'America/Los_Angeles');
        expect(key()).not.toBe(auckland);
      } finally {
        cwd.mockRestore();
      }
    });

    it('builds a fresh line for --verbose and past a torn file', async () => {
      await writeCodexSession('first');
      await runStatusline(options(), { stdin: noInput(), now: at(0) });
      await writeCodexSession('second');

      await runStatusline({ ...options(), verbose: true }, { stdin: noInput(), now: at(1) });
      expect(lines()[1]).not.toBe(lines()[0]);

      await writeFile(`${storePath}.statusline.json`, '{"key":');
      await runStatusline(options(), { stdin: noInput(), now: at(2) });
      expect(lines()[2]).toBe(lines()[1]);
    });
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

      // Node 22 also warns on stderr the first time it loads node:sqlite.
      const hints = stderrSpy.mock.calls.filter(([chunk]) =>
        String(chunk).includes(STATUSLINE_EMPTY_STORE_HINT),
      );
      expect(hints).toEqual([[`${STATUSLINE_EMPTY_STORE_HINT}\n`]]);
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
