// The summary lead: what `llm-usage summary` prints in the terminal (today, the last 7 days
// and the month so far, the month-end notes, the streaks and the year's calendar), from the
// embedded `summary --json` data. Fixed at generation: the page's filters do not change it.

import { computeDeltaRatio } from '../../../../utils/delta-ratio.js';
import { NO_VALUE, type ShareReport } from '../../core/index.js';
import type { ShareLabels } from '../state/context.js';
import {
  formatCompact,
  formatCount,
  formatDateRange,
  formatDay,
  pluralize,
} from '../shell/format.js';
import { buildCalendar, type CalendarView } from './calendar-model.js';
import {
  figure,
  FIXED_NOTE,
  formatEnvelopeCost,
  formatSignedRatio,
  getEnvelopeData,
  isRecord,
  readNumber,
  readRecords,
  readString,
  words,
  type LedePart,
  type PanelCell,
  type PanelFact,
  type PanelTable,
} from './model.js';

export type SummaryView = {
  lede: LedePart[];
  /** The month beyond the lede's projection: budget and cache savings. */
  month: PanelFact[];
  /** The past year: streaks, best day and active days. */
  activity: PanelFact[];
  calendar: CalendarView;
  tables: PanelTable[];
  note: string;
};

type Period = {
  /** `today`, `last7Days` or `monthToDate`. */
  key?: string;
  label: string;
  totals: Record<string, unknown>;
  sources: Record<string, unknown>[];
  machines: Record<string, unknown>[];
  /** The window the period is set against; absent in files from releases before it. */
  previous?: { since: string; until: string; totals: Record<string, unknown> };
};

function readPrevious(value: unknown): Period['previous'] {
  if (!isRecord(value) || !isRecord(value.totals)) {
    return undefined;
  }

  const since = readString(value, 'since');
  const until = readString(value, 'until');
  return since && until ? { since, until, totals: value.totals } : undefined;
}

function readPeriod(record: Record<string, unknown>): Period {
  return {
    key: readString(record, 'key'),
    label: readString(record, 'label') ?? readString(record, 'key') ?? NO_VALUE,
    totals: isRecord(record.totals) ? record.totals : {},
    sources: readRecords(record.sources),
    machines: readRecords(record.machines),
    previous: readPrevious(record.previous),
  };
}

function costOf(record: Record<string, unknown>): PanelCell {
  return formatEnvelopeCost(readNumber(record, 'costUsd'), record.costIncomplete === true);
}

/** A part's share of the period cost, `~`-marked as the terminal marks it; none at zero cost. */
function costShare(period: Period, costUsd: number | undefined): string | undefined {
  const total = readNumber(period.totals, 'costUsd') ?? 0;

  if (total <= 0 || costUsd === undefined) {
    return undefined;
  }

  const approximate = period.totals.costIncomplete === true ? '~' : '';
  return `${approximate}${String(Math.round((costUsd / total) * 100))}%`;
}

function topSource(period: Period): string {
  const top = period.sources.at(0);

  if (!top) {
    return NO_VALUE;
  }

  const name = readString(top, 'source') ?? NO_VALUE;
  const share = costShare(period, readNumber(top, 'costUsd'));
  return share === undefined ? name : `${name} (${share})`;
}

/** The window each period is set against, as `summary` picks it. */
const PREVIOUS_WINDOW_NAMES: Readonly<Record<string, string>> = {
  today: 'yesterday',
  last7Days: 'the 7 days before',
  monthToDate: 'the same days of last month',
};

/** `Against yesterday, Oct 16`: the window the period's change is measured against. */
function previousWindowNote(period: Period): string | undefined {
  const { previous } = period;

  if (!previous) {
    return undefined;
  }

  const name = period.key === undefined ? undefined : PREVIOUS_WINDOW_NAMES[period.key];
  const range = formatDateRange(previous.since, previous.until);
  return name === undefined ? `Against ${range}` : `Against ${name}, ${range}`;
}

/** The table's caption naming each row's previous window, or none for a file without them. */
function previousWindowsCaption(periods: Period[]): string | undefined {
  const named = periods.flatMap((period) => {
    const name = period.key === undefined ? undefined : PREVIOUS_WINDOW_NAMES[period.key];
    return period.previous && name !== undefined ? [`${period.label} against ${name}`] : [];
  });

  return named.length === 0 ? undefined : `${named.join('; ')}.`;
}

/** The previous window's cost, its tooltip naming the window before any lower-bound note. */
function previousCost(period: Period, previous: NonNullable<Period['previous']>): PanelCell {
  const cost = costOf(previous.totals);
  const note = [previousWindowNote(period), cost.note].filter(Boolean).join('. ');
  return { ...cost, note };
}

/** The period's cost against its previous window, as `compare` words a change. */
function costChange(period: Period): PanelCell {
  const { previous } = period;
  const ratio = computeDeltaRatio(
    readNumber(period.totals, 'costUsd'),
    previous && readNumber(previous.totals, 'costUsd'),
  );

  return { text: formatSignedRatio(ratio), note: previousWindowNote(period) };
}

function periodsTable(periods: Period[]): PanelTable {
  // The change is in cost, so a file without cost, or from a release before `previous`, keeps
  // the table it had. With the change, a phone keeps the cost and its change over the tokens.
  const compared = periods.some(
    (period) => period.previous !== undefined && readNumber(period.totals, 'costUsd') !== undefined,
  );

  return {
    title: 'Recent periods',
    columns: [
      { label: 'Period', numeric: false },
      { label: 'Cost', numeric: true },
      ...(compared
        ? [
            { label: 'Previous', numeric: true, narrow: false },
            { label: 'Change', numeric: true },
          ]
        : []),
      { label: 'Tokens', numeric: true, narrow: !compared },
      { label: 'Top source', numeric: false, narrow: false },
    ],
    rows: periods.map((period) => [
      { text: period.label },
      costOf(period.totals),
      ...(compared
        ? [
            period.previous ? previousCost(period, period.previous) : { text: NO_VALUE },
            costChange(period),
          ]
        : []),
      { text: formatCount(readNumber(period.totals, 'totalTokens') ?? 0) },
      { text: topSource(period) },
    ]),
    foot: [],
    caption: compared ? previousWindowsCaption(periods) : undefined,
  };
}

/**
 * Each machine's share of the month, when the month counts usage from more than one: by cost,
 * or by tokens when the month has no known cost, as the terminal's "This month by machine".
 */
function machinesTable(month: Period | undefined, labels: ShareLabels): PanelTable | undefined {
  if (!month || month.machines.length < 2) {
    return undefined;
  }

  const totalTokens = readNumber(month.totals, 'totalTokens') ?? 0;
  const byCost = (readNumber(month.totals, 'costUsd') ?? 0) > 0;

  if (!byCost && totalTokens === 0) {
    return undefined;
  }

  return {
    title: 'This month by machine',
    columns: [
      { label: 'Machine', numeric: false },
      { label: byCost ? 'Cost' : 'Tokens', numeric: true },
      { label: 'Share', numeric: true },
    ],
    rows: month.machines.map((machine) => {
      const tokens = readNumber(machine, 'totalTokens') ?? 0;
      const share = byCost
        ? costShare(month, readNumber(machine, 'costUsd'))
        : `${String(Math.round((tokens / totalTokens) * 100))}%`;

      return [
        { text: labels.machine(readString(machine, 'machine') ?? NO_VALUE) },
        byCost ? costOf(machine) : { text: formatCompact(tokens), note: formatCount(tokens) },
        { text: share ?? NO_VALUE },
      ];
    }),
    foot: [],
  };
}

/** The budget's standing as the terminal words it, or undefined with no budget or no usage. */
function budgetFact(monthEnd: Record<string, unknown>, month: Period | undefined) {
  const budgetUsd = readNumber(monthEnd, 'budgetUsd');

  // An empty month has nothing to hold against the budget yet.
  if (budgetUsd === undefined || (readNumber(month?.totals ?? {}, 'events') ?? 0) === 0) {
    return undefined;
  }

  const budget = formatEnvelopeCost(budgetUsd).text;
  const spentUsd = readNumber(month?.totals ?? {}, 'costUsd');
  const spent = costOf(month?.totals ?? {}).text;
  const projectedUsd = readNumber(monthEnd, 'projectedCostUsd') ?? 0;
  const detail =
    spentUsd === undefined
      ? 'This month’s cost is unknown (no pricing for its usage)'
      : spentUsd > budgetUsd
        ? `Over budget: ${spent} spent`
        : projectedUsd > budgetUsd
          ? `On pace to exceed it by ${formatEnvelopeCost(projectedUsd - budgetUsd, monthEnd.costIncomplete === true).text}`
          : `Within budget: ${spent} spent`;

  return { label: 'Monthly budget', value: budget, detail };
}

function monthFacts(data: Record<string, unknown>, month: Period | undefined): PanelFact[] {
  const monthEnd = isRecord(data.monthEnd) ? data.monthEnd : {};
  const facts: PanelFact[] = [];
  const budget = budgetFact(monthEnd, month);

  if (budget) {
    facts.push(budget);
  }

  const savings = readNumber(data, 'monthToDateCacheSavingsUsd');

  if (savings !== undefined) {
    // The savings are an estimate, so they always carry the approximate marker.
    facts.push({
      label: 'Cache savings',
      value: formatEnvelopeCost(savings, true).text,
      detail: 'This month: cache reads at the input price, less their cost',
    });
  }

  return facts;
}

function activityFacts(activity: Record<string, unknown>): PanelFact[] {
  const best = isRecord(activity.bestDay) ? activity.bestDay : undefined;
  const bestDate = best && readString(best, 'date');
  const bestCost = best && readNumber(best, 'costUsd') !== undefined ? costOf(best).text : '';

  return [
    {
      label: 'Current streak',
      value: pluralize(readNumber(activity, 'currentStreak') ?? 0, 'day'),
    },
    {
      label: 'Longest streak',
      value: pluralize(readNumber(activity, 'longestStreak') ?? 0, 'day'),
    },
    {
      label: 'Best day',
      value: bestDate ? formatDay(bestDate) : NO_VALUE,
      detail: best
        ? [bestCost, `${formatCount(readNumber(best, 'totalTokens') ?? 0)} tokens`]
            .filter((part) => part !== '')
            .join(' · ')
        : undefined,
    },
    {
      label: 'Active days',
      value: formatCount(readNumber(activity, 'activeDays') ?? 0),
      detail: `Since ${formatDay(readString(activity, 'from') ?? '')}`,
    },
  ];
}

/**
 * `~$0.06 spent this month so far, on pace for ~$0.09 by month end (day 21 of 30).`, or its
 * tokens when the month has no cost.
 */
function buildLede(data: Record<string, unknown>, month: Period | undefined): LedePart[] {
  if (!month || (readNumber(month.totals, 'events') ?? 0) === 0) {
    return [words('No usage this month so far.')];
  }

  const costUsd = readNumber(month.totals, 'costUsd');
  const lede =
    costUsd === undefined
      ? [
          figure(formatCompact(readNumber(month.totals, 'totalTokens') ?? 0)),
          words(' tokens this month so far'),
        ]
      : [figure(costOf(month.totals).text), words(' spent this month so far')];
  const monthEnd = isRecord(data.monthEnd) ? data.monthEnd : {};
  const projected = readNumber(monthEnd, 'projectedCostUsd');

  const elapsed = readNumber(monthEnd, 'daysElapsed');
  const length = readNumber(monthEnd, 'daysInMonth');
  const day =
    elapsed === undefined || length === undefined
      ? ''
      : ` (day ${String(elapsed)} of ${String(length)})`;

  return projected === undefined
    ? [...lede, words('.')]
    : [
        ...lede,
        words(', on pace for '),
        figure(formatEnvelopeCost(projected, monthEnd.costIncomplete === true).text),
        words(` by month end${day}.`),
      ];
}

/** The summary lead, or undefined when the file's summary data cannot be read. */
export function buildSummaryView(
  report: ShareReport,
  labels: ShareLabels,
): SummaryView | undefined {
  const data = getEnvelopeData(report, 'summary');

  if (!isRecord(data) || !Array.isArray(data.periods) || !isRecord(data.activity)) {
    return undefined;
  }

  const records = readRecords(data.periods);
  const periods = records.map(readPeriod);
  const monthIndex = records.findIndex((period) => period.key === 'monthToDate');
  const month = monthIndex === -1 ? undefined : periods[monthIndex];
  const activity = data.activity;
  const from = readString(activity, 'from') ?? '';
  const today = readString(records.at(0) ?? {}, 'until');
  const machines = machinesTable(month, labels);
  const timezone = readString(data, 'timezone') ?? report.data.meta.timezone;

  return {
    lede: buildLede(data, month),
    month: monthFacts(data, month),
    activity: activityFacts(activity),
    calendar: buildCalendar(
      readRecords(activity.days),
      (active, count) =>
        `Daily tokens since ${formatDay(from)}: usage on ${pluralize(active, 'day')} of ${formatCount(count)}.`,
    ),
    tables: [periodsTable(periods), ...(machines ? [machines] : [])],
    note: `From the summary command${today ? ` on ${formatDay(today)}` : ''}, in ${timezone}. ${FIXED_NOTE}`,
  };
}
