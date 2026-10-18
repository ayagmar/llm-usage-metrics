import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  calculateCurrentStreak,
  sumDailyTotals,
  type DailyActivity,
} from '../aggregate/daily-activity.js';
import { getEventStoreRuntimeConfig } from '../config/runtime-overrides.js';
import { loadUserConfig } from '../config/user-config.js';
import {
  closeEventStore,
  countEvents,
  openEventStore,
  readEventStoreMeta,
  writeEventStoreMeta,
} from '../persistence/event-store.js';
import { formatApproxUsd, formatStatuslineCompact, formatUsd } from '../render/format-number.js';
import { asRecord, hasErrorCode } from '@ayagmar/agent-sessions/internal';
import { setLogLevel } from '../utils/logger.js';
import {
  buildSummaryDataset,
  resolveMonthEnd,
  resolveMonthlyBudgetUsd,
} from './build-summary-data.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { applyPricingToUsageEventDataset, withPricingNotes } from './build-usage-event-dataset.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { emitReportRunDiagnostics } from './report-runtime/report-lifecycle.js';
import { measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildSummaryDataDeps,
  StatuslineCommandOptions,
  SummaryMonthEnd,
  SummaryPeriod,
  SummaryPeriodKey,
  UsageDiagnostics,
} from './usage-data-contracts.js';
import { createWindowEventFilter, summarizeUsageWindow } from './usage-window-summary.js';

const SEPARATOR = ' · ';

/**
 * Claude Code writes its JSON and closes stdin right away. A status bar that leaves stdin
 * open gets no session part instead of a hung line.
 */
const STDIN_WAIT_MS = 250;

/** What Claude Code tells its status line command about the session it runs in. */
export type ClaudeCodeSession = {
  costUsd?: number;
  contextPercent?: number;
};

function toFiniteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Reads Claude Code's status line JSON; any other input is not a Claude Code session. */
export function parseClaudeCodeSession(input: string): ClaudeCodeSession | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }

  const record = asRecord(parsed);

  if (typeof record?.session_id !== 'string') {
    return undefined;
  }

  return {
    costUsd: toFiniteNonNegative(asRecord(record.cost)?.total_cost_usd),
    contextPercent: toFiniteNonNegative(asRecord(record.context_window)?.used_percentage),
  };
}

type StatuslineStdin = NodeJS.ReadableStream & { isTTY?: boolean; destroy(): void };

/** Piped stdin as text, or '' for a terminal or a pipe that stays open. */
async function readPipedInput(stdin: StatuslineStdin): Promise<string> {
  if (stdin.isTTY) {
    return '';
  }

  const chunks: Buffer[] = [];

  return new Promise((resolve) => {
    const finish = (input: string) => {
      clearTimeout(timer);
      stdin.removeAllListeners('data');
      resolve(input);
    };
    const timer = setTimeout(() => {
      stdin.destroy();
      finish('');
    }, STDIN_WAIT_MS);

    stdin.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stdin.once('end', () => {
      finish(Buffer.concat(chunks).toString('utf8'));
    });
    stdin.once('error', () => {
      finish('');
    });
  });
}

type StatuslinePeriod = Pick<SummaryPeriod, 'key' | 'totals'>;

/** What the line shows. A `SummaryDataResult` is one, so the summary gives the same line. */
export type StatuslineSummary = {
  periods: readonly StatuslinePeriod[];
  monthEnd: SummaryMonthEnd;
  activity: Pick<DailyActivity, 'currentStreak'>;
};

export type StatuslineData = StatuslineSummary & {
  diagnostics: UsageDiagnostics;
  /** No local session file and no event in the year read, other machines' included. */
  foundNoUsage: boolean;
};

function findPeriod(
  summary: StatuslineSummary,
  key: SummaryPeriodKey,
): StatuslinePeriod | undefined {
  return summary.periods.find((period) => period.key === key);
}

/** Cost when known, otherwise tokens, so a day of unpriced usage still shows something. */
function formatPeriodAmount(period: StatuslinePeriod | undefined): string {
  if (period?.totals.costUsd === undefined) {
    return `${formatStatuslineCompact(period?.totals.totalTokens ?? 0)} tokens`;
  }

  return formatApproxUsd(period.totals.costUsd, period.totals.costIncomplete);
}

function formatMonth(summary: StatuslineSummary): string {
  const monthToDate = findPeriod(summary, 'monthToDate');
  const { budgetUsd, projectedCostUsd } = summary.monthEnd;

  const spentUsd = monthToDate?.totals.costUsd;

  // A budget compares dollars: without a known month cost there is nothing to compare.
  if (budgetUsd === undefined || spentUsd === undefined) {
    return `${formatPeriodAmount(monthToDate)} this month`;
  }

  const overPace = Math.max(spentUsd, projectedCostUsd ?? 0) > budgetUsd;

  return `${formatPeriodAmount(monthToDate)}/${formatUsd(budgetUsd)} this month${overPace ? ' ⚠' : ''}`;
}

function formatSession(session: ClaudeCodeSession | undefined): string[] {
  return [
    ...(session?.costUsd === undefined ? [] : [`${formatUsd(session.costUsd)} session`]),
    ...(session?.contextPercent === undefined
      ? []
      : [`${String(Math.round(session.contextPercent))}% context`]),
  ];
}

/**
 * One short line: under Claude Code, the session's cost and context use first; then
 * today's cost, the current streak, and month to date.
 */
export function formatStatusline(summary: StatuslineSummary, session?: ClaudeCodeSession): string {
  const parts = [
    ...formatSession(session),
    `${formatPeriodAmount(findPeriod(summary, 'today'))} today`,
  ];

  if (summary.activity.currentStreak > 0) {
    parts.push(`${summary.activity.currentStreak}d streak`);
  }

  parts.push(formatMonth(summary));
  return parts.join(SEPARATOR);
}

/** What a tick prints while another tick holds the lock and is still parsing. */
const STATUSLINE_WARMING_UP = 'warming up…';

function formatWarmingUpStatusline(session?: ClaudeCodeSession): string {
  return [...formatSession(session), STATUSLINE_WARMING_UP].join(SEPARATOR);
}

/**
 * The summary's line without the rest of the summary. It reads the summary's year of events,
 * which the streak needs, but prices only month to date: pricing maps each event to one
 * priced event (`applyPricingToEvents`), so the line's totals do not change. Prices load
 * when the year's events need them, as for the summary, so a load failure does not change.
 */
export async function buildStatuslineData(
  options: StatuslineCommandOptions,
  deps: BuildSummaryDataDeps,
): Promise<StatuslineData> {
  // A status line refreshes often: cached or bundled prices and other machines' cached
  // usage only, never a network fetch or an ssh connection.
  const { userConfigResolution, timezone, windows, today, since, dataset } =
    await buildSummaryDataset({ ...options, pricingOffline: true, sync: false }, deps);
  // Today, the last 7 days, then month to date (resolveSummaryWindows).
  const [todayWindow, , monthToDateWindow] = windows;
  const monthToDateEvents = dataset.filteredEvents.filter(
    createWindowEventFilter(monthToDateWindow, timezone),
  );
  const pricingResult = await applyPricingToUsageEventDataset(dataset, deps, 'cache-savings', {
    events: monthToDateEvents,
  });
  const { pricedEvents, pricingOrigin, pricingWarning } = pricingResult;
  const sourceOrder = dataset.adaptersToParse.map((adapter) => adapter.id);

  const { periods, currentStreak } = measureRuntimeProfileStageSync(
    deps.runtimeProfile,
    'statusline.aggregate',
    () => ({
      periods: [
        {
          key: todayWindow.key,
          totals: summarizeUsageWindow(
            pricedEvents.filter(createWindowEventFilter(todayWindow, timezone)),
            timezone,
            sourceOrder,
          ).totals,
        },
        {
          key: monthToDateWindow.key,
          totals: summarizeUsageWindow(pricedEvents, timezone, sourceOrder).totals,
        },
      ],
      // The dataset holds the year the summary's activity covers, so the streak has the
      // same cap.
      currentStreak: calculateCurrentStreak(
        new Set(
          sumDailyTotals(dataset.filteredEvents, { from: since, to: today, timezone }).keys(),
        ),
        today,
      ),
    }),
  );

  return {
    periods,
    monthEnd: resolveMonthEnd(today, periods[1], resolveMonthlyBudgetUsd(userConfigResolution)),
    activity: { currentStreak },
    foundNoUsage: dataset.parsedFiles.length === 0 && dataset.filteredEvents.length === 0,
    diagnostics: buildUsageDiagnostics({
      adaptersToParse: dataset.adaptersToParse,
      successfulParseResults: dataset.successfulParseResults,
      sourceFailures: dataset.sourceFailures,
      pricingOrigin,
      pricingWarning,
      warnings: dataset.warnings,
      // Unlike the summary's, these notes count month-to-date events only.
      notes: withPricingNotes(dataset.notes, pricedEvents, pricingResult),
      activeEnvOverrides: dataset.readEnvVarOverrides(),
      activeConfig: dataset.activeConfig,
      timezone,
      runtimeProfile: deps.runtimeProfile?.snapshot(),
    }),
  };
}

export async function buildStatusline(
  options: StatuslineCommandOptions,
  deps: BuildSummaryDataDeps = {},
): Promise<string> {
  return formatStatusline(await buildStatuslineData(options, deps));
}

/**
 * Overlapping ticks share one lock next to the event store, so a cold store is parsed
 * once rather than by every tick that starts before the first one finishes. A tick waits
 * this long for the holder, which a warm tick releases in well under a second.
 */
const STATUSLINE_LOCK_WAIT_MS = 1_000;
const STATUSLINE_LOCK_RETRY_MS = 50;
/** A lock older than this is taken over, as is one whose process has exited. */
const STATUSLINE_LOCK_STALE_MS = 120_000;

function isRunningProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return hasErrorCode(error, 'EPERM');
  }
}

async function isStaleLock(lockPath: string, now: number): Promise<boolean> {
  try {
    const [content, stats] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    const pid = Number.parseInt(content, 10);

    return (
      now - stats.mtimeMs > STATUSLINE_LOCK_STALE_MS ||
      (Number.isInteger(pid) && pid > 0 && !isRunningProcess(pid))
    );
  } catch {
    // Released while we looked: the next attempt takes it.
    return false;
  }
}

/**
 * Takes the tick lock and returns its release, or `undefined` when another tick still
 * holds it after the wait. A lock that cannot be created (an unwritable directory) does
 * not stop the line: the tick runs unlocked, as it did before the lock existed.
 */
export async function acquireStatuslineLock(
  lockPath: string,
  waitMs = STATUSLINE_LOCK_WAIT_MS,
): Promise<(() => Promise<void>) | undefined> {
  const token = String(process.pid);
  const release = async () => {
    // A lock taken over after it went stale is the other tick's to remove.
    if ((await readFile(lockPath, 'utf8').catch(() => undefined)) === token) {
      await rm(lockPath, { force: true });
    }
  };
  const deadline = Date.now() + waitMs;

  try {
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

    for (;;) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(token);
        await handle.close();
        return release;
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) {
          throw error;
        }
      }

      if (await isStaleLock(lockPath, Date.now())) {
        await rm(lockPath, { force: true });
      } else if (Date.now() >= deadline) {
        return undefined;
      } else {
        await sleep(STATUSLINE_LOCK_RETRY_MS);
      }
    }
  } catch {
    return async () => undefined;
  }
}

/** Printed once per event store, on `stderr`, when a tick finds no usage at all. */
export const STATUSLINE_EMPTY_STORE_HINT =
  'llm-usage statusline: no usage logs found yet, so the line shows $0.00. Run `llm-usage doctor` to see where it looks.';
const EMPTY_STORE_HINT_META_KEY = 'statuslineEmptyStoreHintShown';

/** Shows the empty-store hint unless this store showed it before or holds events. */
async function emitEmptyStoreHint(storePath: string): Promise<void> {
  try {
    const store = await openEventStore(storePath);

    try {
      if (readEventStoreMeta(store, EMPTY_STORE_HINT_META_KEY) !== undefined) {
        return;
      }

      if (countEvents(store) === 0) {
        process.stderr.write(`${STATUSLINE_EMPTY_STORE_HINT}\n`);
      }

      writeEventStoreMeta(store, { [EMPTY_STORE_HINT_META_KEY]: new Date().toISOString() });
    } finally {
      closeEventStore(store);
    }
  } catch {
    // A hint is not worth failing the line over; the run already reported store failures.
  }
}

export async function runStatusline(
  options: StatuslineCommandOptions,
  deps: { stdin?: StatuslineStdin } = {},
): Promise<void> {
  // Status bars show stdout, so diagnostics stay off unless --verbose asks for them,
  // as for a report: that is how to debug a slow or odd line. Errors still exit non-zero.
  if (!options.verbose) {
    setLogLevel('silent');
  }

  // Read while the summary builds, so waiting on stdin adds no time.
  const input = readPipedInput(deps.stdin ?? process.stdin);
  const loadedConfig = await loadUserConfig();
  const eventStore = getEventStoreRuntimeConfig(process.env, loadedConfig.config);
  const releaseLock = eventStore.enabled
    ? await acquireStatuslineLock(`${eventStore.path}.statusline.lock`)
    : async () => undefined;

  if (!releaseLock) {
    console.log(formatWarmingUpStatusline(parseClaudeCodeSession(await input)));
    return;
  }

  let summary: StatuslineData;

  try {
    summary = await buildStatuslineData(options, { loadUserConfig: async () => loadedConfig });

    if (eventStore.enabled && summary.foundNoUsage) {
      await emitEmptyStoreHint(eventStore.path);
    }
  } finally {
    await releaseLock();
  }

  const session = parseClaudeCodeSession(await input);

  if (options.verbose) {
    emitReportRunDiagnostics(summary.diagnostics, {
      emitCommonDiagnostics: emitDiagnostics,
      getEnvVarOverrides: (diagnostics) => diagnostics.activeEnvOverrides,
      getActiveConfig: (diagnostics) => diagnostics.activeConfig,
      getRuntimeProfile: (diagnostics) => diagnostics.runtimeProfile,
    });
  }

  console.log(formatStatusline(summary, session));
}
