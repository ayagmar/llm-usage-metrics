import { formatApproxUsd, formatCompact, formatUsd } from '../render/share-svg-theme.js';
import { asRecord } from '../utils/as-record.js';
import { setLogLevel } from '../utils/logger.js';
import { buildSummaryData } from './build-summary-data.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { emitReportRunDiagnostics } from './report-runtime/report-lifecycle.js';
import type {
  BuildSummaryDataDeps,
  StatuslineCommandOptions,
  SummaryDataResult,
  SummaryPeriod,
} from './usage-data-contracts.js';

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

function findPeriod(
  summary: SummaryDataResult,
  key: SummaryPeriod['key'],
): SummaryPeriod | undefined {
  return summary.periods.find((period) => period.key === key);
}

/** Cost when known, otherwise tokens, so a day of unpriced usage still shows something. */
function formatPeriodAmount(period: SummaryPeriod | undefined): string {
  if (period?.totals.costUsd === undefined) {
    return `${formatCompact(period?.totals.totalTokens ?? 0)} tokens`;
  }

  return formatApproxUsd(period.totals.costUsd, period.totals.costIncomplete);
}

function formatMonth(summary: SummaryDataResult): string {
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
export function formatStatusline(summary: SummaryDataResult, session?: ClaudeCodeSession): string {
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

async function buildStatuslineSummary(
  options: StatuslineCommandOptions,
  deps: BuildSummaryDataDeps,
): Promise<SummaryDataResult> {
  if (options.json) {
    throw new Error('--json is not supported for statusline; use llm-usage summary --json');
  }

  // A status line refreshes often: cached or bundled prices and other machines' cached
  // usage only, never a network fetch or an ssh connection.
  return buildSummaryData({ ...options, pricingOffline: true, sync: false }, deps);
}

export async function buildStatusline(
  options: StatuslineCommandOptions,
  deps: BuildSummaryDataDeps = {},
): Promise<string> {
  return formatStatusline(await buildStatuslineSummary(options, deps));
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
  const summary = await buildStatuslineSummary(options, {});
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
