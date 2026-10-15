import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildSummaryData } from '../../src/cli/build-summary-data.js';
import {
  buildStatuslineData,
  formatStatusline,
  parseClaudeCodeSession,
  runStatusline,
} from '../../src/cli/run-statusline.js';
import type { StatuslineCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  openEventStore,
  replaceFileEvents,
} from '../../src/persistence/event-store.js';
import { setLogLevel } from '../../src/utils/logger.js';
import type { SourceAdapter } from '@ayagmar/agent-sessions';
import {
  ALL_SOURCE_IDS,
  captureStdout,
  copyFixtures,
  createE2eSourceOptions,
  fixedNow,
  freezeDate,
  getFixtureSetLabel,
  getFixtureSetOptions,
  listFixtureSets,
  type SourceOptions,
} from '../golden/golden-harness.js';
import { readFrom } from '../helpers/fake-read.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

type Deps = NonNullable<Parameters<typeof buildSummaryData>[1]>;

/**
 * The statusline must print what `formatStatusline` gives for the full summary, and load
 * prices the same way: same origin, same warning, same failure.
 */
async function expectSameLine(options: StatuslineCommandOptions, deps: Deps): Promise<string> {
  const summary = await buildSummaryData({ ...options, pricingOffline: true, sync: false }, deps);
  const statusline = await buildStatuslineData(options, deps);
  const line = formatStatusline(statusline);

  expect(line).toBe(formatStatusline(summary));
  expect(statusline.diagnostics.pricingOrigin).toBe(summary.diagnostics.pricingOrigin);
  expect(statusline.diagnostics.pricingWarning).toBe(summary.diagnostics.pricingWarning);
  return line;
}

describe('statusline equivalence', () => {
  const environment = useIsolatedEnvironment();
  const pricing = useBundledPricingOnly();

  afterAll(() => {
    expect(pricing.fetch).not.toHaveBeenCalled();
  });

  describe('over the golden fixtures', () => {
    let e2eOptions: SourceOptions;

    beforeAll(async () => {
      freezeDate();
      e2eOptions = await createE2eSourceOptions(environment.rootDir);
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it.each(['UTC', 'Asia/Kolkata', 'America/St_Johns'])(
      'matches the summary for every source in %s',
      async (timezone) => {
        await expectSameLine(
          { ...e2eOptions, source: ALL_SOURCE_IDS.join(','), timezone },
          { now: fixedNow },
        );
      },
    );

    it('matches the summary for each fixture set', async () => {
      for (const set of await listFixtureSets()) {
        const options = getFixtureSetOptions(set, e2eOptions, environment.rootDir);

        await expect(
          expectSameLine({ ...options, source: set.source, timezone: 'UTC' }, { now: fixedNow }),
          getFixtureSetLabel(set),
        ).resolves.toBeTypeOf('string');
      }
    });

    it('adds the Claude Code session to the same line', async () => {
      const options = { ...e2eOptions, source: ALL_SOURCE_IDS.join(','), timezone: 'UTC' };
      const input = JSON.stringify({
        session_id: 'session-a',
        cost: { total_cost_usd: 2.5 },
        context_window: { used_percentage: 12.4 },
      });

      try {
        const printed = await captureStdout(() =>
          runStatusline(options, { stdin: Readable.from([Buffer.from(input)]) }),
        );
        const summary = await buildSummaryData(
          { ...options, pricingOffline: true, sync: false },
          {},
        );

        expect(printed).toBe(`${formatStatusline(summary, parseClaudeCodeSession(input))}\n`);
        expect(printed).toMatch(/^\$2\.50 session · 12% context · /u);
      } finally {
        setLogLevel('info');
      }
    });
  });

  describe('over a generated year', () => {
    const DAY_MS = 86_400_000;
    // UTC times of day: around midnight, a local day differs from the UTC one.
    const TIMES = ['00:10', '12:00', '23:50', '06:30', '18:45'];
    const MODELS: Partial<Parameters<typeof createUsageEvent>[0]>[] = [
      { model: 'gpt-4.1', costMode: 'estimated' },
      { model: 'gpt-4.1', costMode: 'explicit', costUsd: 0.75 },
      // An explicit $0: `both` estimates it, `explicit` keeps it.
      { model: 'gpt-4.1-mini', costMode: 'explicit', costUsd: 0 },
      // No known price.
      { model: 'unpriced-model-x', costMode: 'estimated' },
      // No tokens: still an active day.
      { model: 'gpt-4.1', inputTokens: 0, outputTokens: 0, totalTokens: 0, costMode: 'estimated' },
    ];

    type Generated = { now: Date; codex: UsageEvent[]; claude: UsageEvent[] };

    /**
     * Usage on most days of the 400 days before `now`; the first gap is 32 days back, so the
     * streak crosses the month start but ends.
     */
    function generateYear(nowIso: string, { inactiveToday = false } = {}): Generated {
      const now = new Date(nowIso);
      const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const codex: UsageEvent[] = [];
      const claude: UsageEvent[] = [];

      for (let daysBack = 0; daysBack < 400; daysBack += 1) {
        if ((daysBack > 25 && daysBack % 9 === 5) || (inactiveToday && daysBack === 0)) {
          continue;
        }

        const day = new Date(todayStart - daysBack * DAY_MS).toISOString().slice(0, 10);

        for (let index = 0; index <= daysBack % 3; index += 1) {
          const timestamp = `${day}T${TIMES[(daysBack + index) % TIMES.length]}:00.000Z`;

          if (Date.parse(timestamp) > now.getTime()) {
            continue;
          }

          codex.push(
            createUsageEvent({
              source: 'codex',
              sessionId: `codex-${String(daysBack % 4)}`,
              timestamp,
              provider: 'openai',
              inputTokens: 1_000 * (index + 1),
              outputTokens: 300 + daysBack,
              totalTokens: 1_000 * (index + 1) + 300 + daysBack,
              ...MODELS[(daysBack + index) % MODELS.length],
            }),
          );
          claude.push(
            createUsageEvent({
              source: 'claude',
              sessionId: 'claude-original',
              timestamp,
              provider: 'anthropic',
              model: 'claude-sonnet-4',
              inputTokens: 2_000,
              outputTokens: 100 * (index + 1),
              cacheReadTokens: 50_000,
              totalTokens: 52_000 + 100 * (index + 1),
              costMode: daysBack % 2 === 0 ? 'estimated' : 'explicit',
              costUsd: daysBack % 2 === 0 ? undefined : 0.42,
            }),
          );
        }
      }

      // A session continued from another repeats its rows; the copies count once.
      const copies = claude
        .filter((_, index) => index % 5 === 0)
        .map((event) => ({ ...event, sessionId: 'claude-continued' }));

      return { now, codex, claude: [...claude, ...copies] };
    }

    function deps(generated: Generated, monthlyBudgetUsd?: number): Deps {
      const adapter = (
        id: string,
        events: UsageEvent[],
        capabilities?: SourceAdapter['capabilities'],
      ): SourceAdapter => ({
        id,
        capabilities,
        discoverFiles: async () => [`/generated/${id}.jsonl`],
        read: readFrom(async () => events),
      });

      return {
        getParsingRuntimeConfig: () => ({
          maxParallelFileParsing: 2,
          parseWorkers: 0,
          parseWorkerMinBytes: 268_435_456,
        }),
        getEventStoreRuntimeConfig: () => ({
          enabled: false as const,
          path: '/generated/events.db',
          disabledBy: 'environment' as const,
        }),
        getActiveEnvVarOverrides: () => [],
        createAdapters: () => [
          adapter('codex', generated.codex),
          adapter('claude', generated.claude, { sessionsCopyEvents: true }),
        ],
        loadUserConfig: async () => ({
          config: { monthlyBudgetUsd },
          path: '/generated/config.toml',
          exists: monthlyBudgetUsd !== undefined,
          warnings: [],
        }),
        now: () => generated.now,
      };
    }

    const scenarios: {
      name: string;
      now: string;
      timezone: string;
      options?: Partial<StatuslineCommandOptions>;
      inactiveToday?: boolean;
      budget?: number;
    }[] = [
      { name: 'second day of a month', now: '2026-03-02T15:00:00.000Z', timezone: 'UTC' },
      {
        name: 'mid-month with a budget',
        now: '2026-03-15T15:00:00.000Z',
        timezone: 'UTC',
        budget: 40,
      },
      {
        name: 'an inactive today',
        now: '2026-03-15T15:00:00.000Z',
        timezone: 'UTC',
        inactiveToday: true,
      },
      // 00:15 on Apr 1 in India: a new month there, still Mar 31 in UTC.
      {
        name: 'a 30-minute offset at the month start',
        now: '2026-03-31T18:45:00.000Z',
        timezone: 'Asia/Kolkata',
      },
      {
        name: 'a negative 30-minute offset',
        now: '2026-04-01T02:00:00.000Z',
        timezone: 'America/St_Johns',
      },
      {
        name: '--cost-mode explicit',
        now: '2026-03-02T15:00:00.000Z',
        timezone: 'UTC',
        options: { costMode: 'explicit' },
      },
      {
        name: '--cost-mode estimated',
        now: '2026-03-15T15:00:00.000Z',
        timezone: 'UTC',
        options: { costMode: 'estimated' },
      },
    ];

    it.each(scenarios)(
      'matches the summary: $name',
      async ({ now, timezone, options, inactiveToday, budget }) => {
        await expectSameLine(
          { timezone, ...options },
          deps(generateYear(now, { inactiveToday }), budget),
        );
      },
    );

    it('keeps a streak that crosses the month start', async () => {
      const line = await expectSameLine(
        { timezone: 'UTC' },
        deps(generateYear('2026-03-02T15:00:00.000Z')),
      );

      expect(line).toContain(' · 32d streak · ');
    });

    it('counts an inactive today as a streak ending yesterday', async () => {
      const line = await expectSameLine(
        { timezone: 'UTC' },
        deps(generateYear('2026-03-15T15:00:00.000Z', { inactiveToday: true })),
      );

      expect(line).toMatch(/^\$0\.00 today · 31d streak · /u);
    });

    it('matches --model exactly when the exact name appears only before the month', async () => {
      const generated = generateYear('2026-03-10T15:00:00.000Z');
      // gpt-4.1 only before March: still an exact match, so March's gpt-4.1-mini is left out.
      generated.codex = generated.codex.map((event) =>
        event.model === 'gpt-4.1' && event.timestamp >= '2026-03'
          ? { ...event, model: 'gpt-4.1-mini' }
          : event,
      );

      const line = await expectSameLine({ timezone: 'UTC', model: ['gpt-4.1'] }, deps(generated));

      // A substring match would count March's gpt-4.1-mini.
      expect(line).toMatch(/ · \$0\.00 this month$/u);
    });
  });

  describe('with history', () => {
    let sources: StatuslineCommandOptions;

    async function storeDepartedFile(
      dbPath: string,
      filePath: string,
      events: UsageEvent[],
    ): Promise<void> {
      const store = await openEventStore(dbPath);

      try {
        replaceFileEvents(store, {
          source: 'codex',
          filePath,
          fingerprint: { dependencies: [{ path: filePath, exists: true, size: 10, mtimeMs: 20 }] },
          events,
          skippedRows: 0,
          now: 1_000,
        });
      } finally {
        closeEventStore(store);
      }
    }

    beforeAll(async () => {
      freezeDate();
      const historyRoot = path.join(environment.rootDir, 'history');
      await mkdir(historyRoot);
      const { e2eRoot } = await copyFixtures(historyRoot);
      sources = {
        codexDir: path.join(e2eRoot, 'codex'),
        source: 'codex',
        timezone: 'UTC',
        history: true,
      };
      const dbPath = path.join(historyRoot, 'events.db');
      vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
      vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', dbPath);

      const departed = (timestamp: string, sessionId: string) =>
        createUsageEvent({
          source: 'codex',
          sessionId,
          timestamp,
          model: 'gpt-4.1',
          inputTokens: 100_000,
          outputTokens: 4_000,
          totalTokens: 104_000,
          costMode: 'estimated',
        });
      // Departed usage before this month, at its start, and yesterday (FIXED_NOW is Jun 21).
      await storeDepartedFile(dbPath, path.join(historyRoot, 'departed', 'old.jsonl'), [
        departed('2026-05-31T23:00:00.000Z', 'departed-a'),
        departed('2026-06-01T01:00:00.000Z', 'departed-a'),
        departed('2026-06-20T10:00:00.000Z', 'departed-a'),
      ]);
      // The same file moved: history counts it once.
      await storeDepartedFile(dbPath, path.join(historyRoot, 'departed', 'moved.jsonl'), [
        departed('2026-05-31T23:00:00.000Z', 'departed-a'),
        departed('2026-06-01T01:00:00.000Z', 'departed-a'),
        departed('2026-06-20T10:00:00.000Z', 'departed-a'),
      ]);
    });

    afterAll(() => {
      vi.useRealTimers();
      vi.stubEnv('LLM_USAGE_EVENT_STORE', '0');
      vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', undefined);
    });

    it('matches the summary with departed files counted', async () => {
      const line = await expectSameLine(sources, { now: fixedNow });
      const withoutHistory = await expectSameLine(
        { ...sources, history: false },
        { now: fixedNow },
      );

      expect(line).not.toBe(withoutHistory);
    });
  });
});
