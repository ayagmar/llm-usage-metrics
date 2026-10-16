// The wrapped recap: the year's figures, the daily calendar and the top lists, from the
// embedded `wrapped --json` data. Fixed at generation: the page's filters do not change it.

import { getIsoDayOfWeek, parseDateKey } from '../../../../utils/date-key.js';
import { getWindowEnd, NO_VALUE, WEEKDAY_LABELS, type ShareReport } from '../../core/index.js';
import {
  formatCompact,
  formatCount,
  formatDay,
  formatDuration,
  formatPercent,
  pluralize,
} from '../shell/format.js';
import {
  formatEnvelopeCost,
  getEnvelopeData,
  isRecord,
  readNumber,
  readRecords,
  readString,
  type PanelFact,
  type PanelTable,
} from './model.js';

/** A day in the calendar: its week column, its weekday row (Monday 0) and its heat level. */
export type CalendarDay = {
  week: number;
  weekday: number;
  /** 0 for no usage, then 1–4 as the CLI's intensity levels. */
  level: number;
  label: string;
};

export type CalendarView = {
  weeks: number;
  days: CalendarDay[];
  /** Month names over the week column holding their first day. */
  months: { label: string; week: number }[];
  weekdays: readonly string[];
  /** One sentence for screen readers; the monthly table holds the figures. */
  summary: string;
};

export type TopItem = {
  rank: number;
  name: string;
  /** Compact, with the exact count in {@link TopItem.tokensExact}. */
  tokens: string;
  tokensExact: string;
  cost: string;
  costNote?: string;
  /** The item's share of the list's largest value (cost when the list has costs), 0–1. */
  share: number;
};

export type TopList = { title: string; nameLabel: string; items: TopItem[] };

export type WrappedView = {
  year: string;
  /** The lede: figures and the words between them. */
  lede: { text: string; figure: boolean }[];
  facts: PanelFact[];
  calendar: CalendarView;
  months: PanelTable;
  topLists: TopList[];
  note: string;
};

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function clampLevel(level: number | undefined): number {
  return level === undefined ? 0 : Math.min(4, Math.max(0, Math.round(level)));
}

const DAY_MS = 86_400_000;

/** Weeks run Monday to Sunday, as the CLI's ISO weeks; the first column holds the first day. */
function buildCalendar(year: string, days: Record<string, unknown>[]): CalendarView {
  const placed: CalendarDay[] = [];
  const months: CalendarView['months'] = [];
  // The Monday on or before the first day, as a day number; weeks count from it.
  let firstMonday: number | undefined;
  let activeDays = 0;

  for (const day of days) {
    const date = readString(day, 'date');
    const parts = date === undefined ? undefined : parseDateKey(date);

    if (date === undefined || parts === undefined) {
      continue;
    }

    const weekday = getIsoDayOfWeek(parts) - 1;
    const dayNumber = Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS;
    firstMonday ??= dayNumber - weekday;
    const week = Math.floor((dayNumber - firstMonday) / 7);
    const tokens = readNumber(day, 'totalTokens') ?? 0;
    const level = clampLevel(readNumber(day, 'level'));

    if (tokens > 0) {
      activeDays += 1;
    }

    if (parts.day === 1) {
      months.push({ label: MONTH_NAMES[parts.month - 1], week });
    }

    placed.push({
      week,
      weekday,
      level,
      label: `${formatDay(date)}: ${tokens > 0 ? `${formatCount(tokens)} tokens` : 'no usage'}`,
    });
  }

  return {
    weeks: Math.max(0, ...placed.map((day) => day.week + 1)),
    days: placed,
    months,
    weekdays: WEEKDAY_LABELS,
    summary: `Daily tokens in ${year}: usage on ${pluralize(activeDays, 'day')} of ${formatCount(placed.length)}. The monthly table holds the totals.`,
  };
}

function buildMonths(months: Record<string, unknown>[]): PanelTable {
  return {
    title: 'By month',
    columns: [
      { label: 'Month', numeric: false },
      { label: 'Tokens', numeric: true },
      { label: 'Cost', numeric: true },
    ],
    rows: months.map((month) => {
      const key = readString(month, 'month') ?? '';
      const index = Number(key.slice(5, 7)) - 1;
      return [
        { text: MONTH_NAMES[index] ?? key },
        { text: formatCount(readNumber(month, 'totalTokens') ?? 0) },
        formatEnvelopeCost(readNumber(month, 'costUsd'), month.costIncomplete === true),
      ];
    }),
    foot: [],
  };
}

function buildTopList(title: string, nameLabel: string, items: Record<string, unknown>[]): TopList {
  const hasCost = items.some((item) => readNumber(item, 'costUsd') !== undefined);
  const metric = (item: Record<string, unknown>) =>
    readNumber(item, hasCost ? 'costUsd' : 'totalTokens') ?? 0;
  const largest = Math.max(0, ...items.map(metric));

  return {
    title,
    nameLabel,
    items: items.map((item, index) => {
      const cost = formatEnvelopeCost(readNumber(item, 'costUsd'), item.costIncomplete === true);
      return {
        rank: index + 1,
        name: readString(item, 'name') ?? NO_VALUE,
        tokens: formatCompact(readNumber(item, 'totalTokens') ?? 0),
        tokensExact: `${formatCount(readNumber(item, 'totalTokens') ?? 0)} tokens`,
        cost: cost.text,
        costNote: cost.note,
        share: largest > 0 ? metric(item) / largest : 0,
      };
    }),
  };
}

function buildFacts(data: Record<string, unknown>): PanelFact[] {
  const facts: PanelFact[] = [
    {
      label: 'Active time',
      value: formatDuration(readNumber(data, 'activeMs') ?? 0),
      detail: '5-minute gaps at most',
    },
    { label: 'Longest streak', value: pluralize(readNumber(data, 'longestStreak') ?? 0, 'day') },
  ];

  const peak = isRecord(data.peakHour) ? readNumber(data.peakHour, 'hour') : undefined;
  facts.push({
    label: 'Peak hour',
    value: peak === undefined ? NO_VALUE : `${String(peak).padStart(2, '0')}:00`,
    detail: peak === undefined ? undefined : 'The hour of day with the most tokens',
  });

  const weekday = readNumber(data, 'weekdayTokens') ?? 0;
  const weekend = readNumber(data, 'weekendTokens') ?? 0;
  facts.push({
    label: 'Weekdays',
    value: weekday + weekend > 0 ? formatPercent(weekday / (weekday + weekend)) : NO_VALUE,
    detail: 'Share of tokens Monday to Friday',
  });

  const busiest = isRecord(data.busiestDay) ? data.busiestDay : undefined;
  const busiestDate = busiest && readString(busiest, 'date');
  facts.push({
    label: 'Busiest day',
    value: busiestDate ? formatDay(busiestDate) : NO_VALUE,
    detail: busiest ? `${formatCount(readNumber(busiest, 'totalTokens') ?? 0)} tokens` : undefined,
  });

  const savings = readNumber(data, 'estimatedCacheSavingsUsd');

  if (savings !== undefined) {
    facts.push({
      label: 'Cache savings',
      value: `~${formatEnvelopeCost(savings).text}`,
      detail: 'Estimated: cache reads at the input price, less their cost',
    });
  }

  facts.push(
    { label: 'Events', value: formatCount(readNumber(data, 'eventCount') ?? 0) },
    { label: 'Sessions', value: formatCount(readNumber(data, 'sessionCount') ?? 0) },
  );

  return facts;
}

function buildLede(data: Record<string, unknown>, year: string): WrappedView['lede'] {
  const tokens = readNumber(data, 'totalTokens') ?? 0;
  const activeDays = readNumber(data, 'activeDays') ?? 0;
  const cost = readNumber(data, 'costUsd');
  const lede: WrappedView['lede'] = [
    { text: formatCompact(tokens), figure: true },
    { text: ' tokens', figure: false },
  ];

  if (cost !== undefined) {
    lede.push(
      { text: ' and ', figure: false },
      { text: formatEnvelopeCost(cost, data.costIncomplete === true).text, figure: true },
    );
  }

  lede.push(
    { text: ' across ', figure: false },
    { text: formatCount(activeDays), figure: true },
    { text: ` active ${activeDays === 1 ? 'day' : 'days'} in ${year}.`, figure: false },
  );

  return lede;
}

/** The recap of a wrapped file, or undefined when its data cannot be read. */
export function buildWrappedView(report: ShareReport): WrappedView | undefined {
  const data = getEnvelopeData(report, 'wrapped');

  if (!isRecord(data) || readNumber(data, 'year') === undefined) {
    return undefined;
  }

  const year = String(readNumber(data, 'year'));
  const timezone = readString(data, 'timezone') ?? report.data.meta.timezone;
  // The current year stops at the generation date, as the page's charts do.
  const end = getWindowEnd(report) ?? `${year}-12-31`;
  const days = readRecords(data.dailyIntensity).filter((day) => String(day.date) <= end);
  const months = readRecords(data.monthlyIntensity).filter(
    (month) => String(month.month) <= end.slice(0, 7),
  );

  return {
    year,
    lede: buildLede(data, year),
    facts: buildFacts(data),
    calendar: buildCalendar(year, days),
    months: buildMonths(months),
    topLists: [
      buildTopList('Top models', 'Model', readRecords(data.topModels)),
      buildTopList('Top sources', 'Source', readRecords(data.topSources)),
    ].filter((list) => list.items.length > 0),
    note: `From wrapped for ${year}, in ${timezone}. The controls below do not change it.`,
  };
}
