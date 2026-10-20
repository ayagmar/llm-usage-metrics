import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import type { UsageEvent } from '../domain/usage-event.js';
import type { PeriodProjectRow } from '../domain/usage-report-row.js';
import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';
import { getPeriodKeyRange } from '../utils/time-buckets.js';
import { getMonthEndDateKey } from '../utils/date-key.js';
import { addUsd } from '../utils/usd-math.js';
import { PLANS_AS_OF, type SelectedPlan } from './plans.js';

export type ValueProjectRow = {
  /** The project key, `null` for usage without a repository root. */
  repoRoot: string | null;
  project: string;
  totalTokens: number;
  /** Cost of the events that have one; `costIncomplete` when some have none. */
  costUsd: number;
  costIncomplete: boolean;
  /** Share of the month's cost, rounded by `roundRatio`; `null` when the month cost nothing. */
  costShare: number | null;
};

/** The projects of a month that the project limit left out, summed. */
export type ValueOtherProjects = {
  /** How many projects. */
  projects: number;
  totalTokens: number;
  costUsd: number;
  costIncomplete: boolean;
  /** Share of the month's cost, rounded by `roundRatio`; `null` when the month cost nothing. */
  costShare: number | null;
};

export type ValueMonthRow = {
  /** `YYYY-MM` in the report timezone. */
  month: string;
  /** The window does not cover the whole month, or the month contains today; not prorated. */
  partial: boolean;
  totalTokens: number;
  apiCostUsd: number;
  costIncomplete: boolean;
  planPriceUsd: number;
  /** API cost divided by the plan price. */
  ratio: number;
  /** API cost minus the plan price: positive when the plan cost less than the API would. */
  differenceUsd: number;
  /** The month's costliest projects, at most the project limit. */
  projects: ValueProjectRow[];
  /** The projects past the limit; `null` when none were left out. */
  otherProjects: ValueOtherProjects | null;
};

export type ValuePlanReport = {
  id: string;
  /** The monthly price the report uses. */
  priceUsdPerMonth: number;
  /** The price listed on `asOf`. */
  listPriceUsdPerMonth: number;
  /** `override` when --plan-price replaced the list price. */
  priceSource: 'list' | 'override';
  /** The plan's sources that the report counts (after --source). */
  sources: string[];
  /** Vendor pages that list the current prices. */
  checkAt: string[];
  /** The third-party summaries the list prices were taken from. */
  references: string[];
  months: ValueMonthRow[];
  total: {
    totalTokens: number;
    apiCostUsd: number;
    costIncomplete: boolean;
    /** The plan price times the number of months, partial months counted in full. */
    planPriceUsd: number;
    /** `null` without months. */
    ratio: number | null;
    differenceUsd: number;
  };
};

export type ValueReportData = {
  /** The date the list prices were checked. */
  asOf: string;
  window: {
    /** First day of the window; `null` without usage and without --since or --last. */
    since: string | null;
    /** Last day of the window: --until or today, whichever comes first. */
    until: string;
  };
  plans: ValuePlanReport[];
};

/** A plan and the sources it counts. */
export type PlanScope = {
  selected: SelectedPlan;
  sources: readonly string[];
};

/**
 * Each plan's sources narrowed by a source filter (`--source` or config `sources`). A plan
 * left with none is an error, since its table would always be empty.
 */
export function resolvePlanScopes(
  plans: readonly SelectedPlan[],
  sourceFilter: ReadonlySet<string> | undefined,
  sourceFilterLabel = '--source',
): PlanScope[] {
  return plans.map((selected) => {
    const sources = selected.plan.sources.filter(
      (source) => !sourceFilter || sourceFilter.has(source),
    );

    if (sources.length === 0) {
      throw new Error(
        `${sourceFilterLabel} leaves out every source of plan ${selected.plan.id} (${selected.plan.sources.join(', ')}); pass a --plan <id> that covers a source it keeps`,
      );
    }

    return { selected, sources };
  });
}

export type BuildValueReportOptions = {
  plans: readonly PlanScope[];
  timezone: string;
  /** Today's local date key in the report timezone. */
  today: string;
  /** The window's dates (--since, --until, or what --last resolved to). */
  since?: string;
  /** Today when absent or later: months after today never get a row. */
  until?: string;
  /** Labels from one `buildEventProjectLabels` call over every event of the report. */
  projectLabels: ReadonlyMap<string | undefined, string>;
  /** How many projects each month lists; every project when absent. */
  projectLimit?: number;
};

const RATIO_SCALE = 1_000_000;

/** Ratios and cost shares in report JSON: 6 decimal places. */
export function roundRatio(value: number): number {
  return Math.round(value * RATIO_SCALE) / RATIO_SCALE;
}

function getMonthKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}

/** Projects by cost, then tokens, then label. */
function compareProjectRows(left: ValueProjectRow, right: ValueProjectRow): number {
  return (
    right.costUsd - left.costUsd ||
    right.totalTokens - left.totalTokens ||
    compareByCodePoint(left.project, right.project)
  );
}

function toProjectRows(rows: readonly PeriodProjectRow[], monthCostUsd: number): ValueProjectRow[] {
  return rows
    .map((row) => {
      const costUsd = row.costUsd ?? 0;

      return {
        repoRoot: row.repoRoot,
        project: row.project,
        totalTokens: row.totalTokens,
        costUsd,
        costIncomplete: row.costIncomplete === true,
        costShare: monthCostUsd > 0 ? roundRatio(costUsd / monthCostUsd) : null,
      };
    })
    .sort(compareProjectRows);
}

function sumOtherProjects(
  rows: readonly ValueProjectRow[],
  monthCostUsd: number,
): ValueOtherProjects | null {
  if (rows.length === 0) {
    return null;
  }

  let totalTokens = 0;
  let costUsd = 0;
  let costIncomplete = false;

  for (const row of rows) {
    totalTokens += row.totalTokens;
    costUsd = addUsd(costUsd, row.costUsd);
    costIncomplete ||= row.costIncomplete;
  }

  return {
    projects: rows.length,
    totalTokens,
    costUsd,
    costIncomplete,
    costShare: monthCostUsd > 0 ? roundRatio(costUsd / monthCostUsd) : null,
  };
}

function toMonthRow(
  month: string,
  rows: readonly PeriodProjectRow[],
  planPriceUsd: number,
  partial: boolean,
  projectLimit: number | undefined,
): ValueMonthRow {
  let totalTokens = 0;
  let apiCostUsd = 0;
  let costIncomplete = false;

  for (const row of rows) {
    totalTokens += row.totalTokens;
    apiCostUsd = addUsd(apiCostUsd, row.costUsd ?? 0);
    costIncomplete ||= row.costIncomplete === true;
  }

  const projects = toProjectRows(rows, apiCostUsd);
  const shownCount = projectLimit ?? projects.length;

  return {
    month,
    partial,
    totalTokens,
    apiCostUsd,
    costIncomplete,
    planPriceUsd,
    ratio: roundRatio(apiCostUsd / planPriceUsd),
    differenceUsd: addUsd(apiCostUsd, -planPriceUsd),
    projects: projects.slice(0, shownCount),
    otherProjects: sumOtherProjects(projects.slice(shownCount), apiCostUsd),
  };
}

function toPlanTotal(months: readonly ValueMonthRow[]): ValuePlanReport['total'] {
  let totalTokens = 0;
  let apiCostUsd = 0;
  let costIncomplete = false;
  let planPriceUsd = 0;

  for (const month of months) {
    totalTokens += month.totalTokens;
    apiCostUsd = addUsd(apiCostUsd, month.apiCostUsd);
    costIncomplete ||= month.costIncomplete;
    planPriceUsd = addUsd(planPriceUsd, month.planPriceUsd);
  }

  return {
    totalTokens,
    apiCostUsd,
    costIncomplete,
    planPriceUsd,
    ratio: planPriceUsd > 0 ? roundRatio(apiCostUsd / planPriceUsd) : null,
    differenceUsd: addUsd(apiCostUsd, -planPriceUsd),
  };
}

/**
 * API-priced cost per calendar month next to each plan's price, over the plan's sources.
 *
 * The window starts at --since, else on the 1st of the first event's month, and ends at
 * --until or today, whichever comes first, so months after today never get a row. Every
 * month in it gets a row, idle months at $0; a month the window cuts or that contains
 * today is marked partial, not prorated.
 */
export function buildValueReport(
  events: readonly UsageEvent[],
  options: BuildValueReportOptions,
): ValueReportData {
  const rowsByPlan = options.plans.map(({ sources }) => {
    const planSources = new Set(sources);
    const rows = aggregateUsage(
      events.filter((event) => planSources.has(event.source)),
      {
        granularity: 'monthly',
        timezone: options.timezone,
        primary: 'repo',
        projectLabels: options.projectLabels,
        includeModelBreakdown: false,
      },
    );
    const rowsByMonth = new Map<string, PeriodProjectRow[]>();

    for (const row of rows) {
      if (row.rowType === 'period_project') {
        rowsByMonth.set(row.periodKey, [...(rowsByMonth.get(row.periodKey) ?? []), row]);
      }
    }

    return rowsByMonth;
  });

  const until =
    options.until !== undefined && options.until < options.today ? options.until : options.today;
  const lastMonth = getMonthKey(until);
  const usageMonths = rowsByPlan
    .flatMap((rowsByMonth) => [...rowsByMonth.keys()])
    .filter((month) => month <= lastMonth)
    .sort(compareByCodePoint);
  const since = options.since ?? (usageMonths.length > 0 ? `${usageMonths[0]}-01` : undefined);
  const months =
    since === undefined ? [] : getPeriodKeyRange(getMonthKey(since), lastMonth, 'monthly');
  const isPartial = (month: string): boolean => {
    const firstDay = `${month}-01`;
    const lastDay = getMonthEndDateKey(firstDay);

    return (
      (since !== undefined && since > firstDay) ||
      until < lastDay ||
      (options.today >= firstDay && options.today <= lastDay)
    );
  };

  return {
    asOf: PLANS_AS_OF,
    window: { since: since ?? null, until },
    plans: options.plans.map(({ selected, sources }, index) => {
      const rowsByMonth = rowsByPlan[index];
      const monthRows = months.map((month) =>
        toMonthRow(
          month,
          rowsByMonth.get(month) ?? [],
          selected.priceUsdPerMonth,
          isPartial(month),
          options.projectLimit,
        ),
      );

      return {
        id: selected.plan.id,
        priceUsdPerMonth: selected.priceUsdPerMonth,
        listPriceUsdPerMonth: selected.plan.priceUsdPerMonth,
        priceSource: selected.priceSource,
        sources: [...sources],
        checkAt: [...selected.plan.vendor.checkAt],
        references: [...selected.plan.vendor.references],
        months: monthRows,
        total: toPlanTotal(monthRows),
      };
    }),
  };
}
