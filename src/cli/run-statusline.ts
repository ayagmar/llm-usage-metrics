import { formatApproxUsd, formatCompact, formatUsd } from '../render/share-svg-theme.js';
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

  if (budgetUsd === undefined) {
    return `${formatPeriodAmount(monthToDate)} this month`;
  }

  const spentUsd = monthToDate?.totals.costUsd ?? 0;
  const overPace = Math.max(spentUsd, projectedCostUsd ?? 0) > budgetUsd;

  return `${formatPeriodAmount(monthToDate)}/${formatUsd(budgetUsd)} this month${overPace ? ' ⚠' : ''}`;
}

/** One short line: today's cost, the current streak, and month to date. */
export function formatStatusline(summary: SummaryDataResult): string {
  const parts = [`${formatPeriodAmount(findPeriod(summary, 'today'))} today`];

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

  // A status line refreshes often: cached or bundled prices only, never a network fetch.
  return buildSummaryData({ ...options, pricingOffline: true }, deps);
}

export async function buildStatusline(
  options: StatuslineCommandOptions,
  deps: BuildSummaryDataDeps = {},
): Promise<string> {
  return formatStatusline(await buildStatuslineSummary(options, deps));
}

export async function runStatusline(
  options: StatuslineCommandOptions,
  deps: BuildSummaryDataDeps = {},
): Promise<void> {
  // Status bars show stdout, so diagnostics stay off unless --verbose asks for them,
  // as for a report: that is how to debug a slow or odd line. Errors still exit non-zero.
  if (!options.verbose) {
    setLogLevel('silent');
  }

  const summary = await buildStatuslineSummary(options, deps);

  if (options.verbose) {
    emitReportRunDiagnostics(summary.diagnostics, {
      emitCommonDiagnostics: emitDiagnostics,
      getEnvVarOverrides: (diagnostics) => diagnostics.activeEnvOverrides,
      getActiveConfig: (diagnostics) => diagnostics.activeConfig,
      getRuntimeProfile: (diagnostics) => diagnostics.runtimeProfile,
    });
  }

  console.log(formatStatusline(summary));
}
