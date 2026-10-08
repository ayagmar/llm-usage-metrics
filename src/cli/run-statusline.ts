import { formatApproxUsd, formatCompact, formatUsd } from '../render/share-svg-theme.js';
import { setLogLevel } from '../utils/logger.js';
import { buildSummaryData } from './build-summary-data.js';
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

export async function buildStatusline(
  options: StatuslineCommandOptions,
  deps: BuildSummaryDataDeps = {},
): Promise<string> {
  if (options.json) {
    throw new Error('--json is not supported for statusline; use llm-usage summary --json');
  }

  // A status line refreshes often: cached or bundled prices only, never a network fetch.
  return formatStatusline(await buildSummaryData({ ...options, pricingOffline: true }, deps));
}

export async function runStatusline(options: StatuslineCommandOptions): Promise<void> {
  // Status bars show stdout; diagnostics would only add noise. Errors still exit non-zero,
  // and --verbose keeps the configured level to debug a slow or odd line.
  if (!options.verbose) {
    setLogLevel('silent');
  }

  console.log(await buildStatusline(options));
}
