// The wrapped recap: the year's figures, the daily calendar and the top lists, from the
// embedded `wrapped --json` data. Fixed at generation: the page's filters do not change it.

import { MONTH_LABELS } from '../../../../render/month-labels.js';
import { formatHours } from '../../../../render/format-duration.js';
import { getWindowEnd, NO_VALUE, type ShareReport } from '../../core/index.js';
import { formatDay, formatPercent } from '../shell/format.js';
import { buildCalendar, type CalendarView } from './calendar-model.js';
import {
  formatEnvelopeCost,
  getEnvelopeData,
  isRecord,
  readNumber,
  readRecords,
  readString,
  type LedePart,
  type PanelFact,
  type PanelTable,
} from './model.js';
import { pluralize } from '../../../../../packages/core/src/utils/pluralize.js';
import { formatAbbreviatedTokenCount, formatInteger } from '../../../../render/format-number.js';

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
  lede: LedePart[];
  facts: PanelFact[];
  calendar: CalendarView;
  months: PanelTable;
  topLists: TopList[];
  note: string;
};

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
        { text: MONTH_LABELS[index] ?? key },
        { text: formatInteger(readNumber(month, 'totalTokens') ?? 0) },
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
        tokens: formatAbbreviatedTokenCount(readNumber(item, 'totalTokens') ?? 0),
        tokensExact: `${formatInteger(readNumber(item, 'totalTokens') ?? 0)} tokens`,
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
      // The terminal's Hours: whole hours, `<1h` under half an hour.
      value: formatHours(readNumber(data, 'activeMs') ?? 0),
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
    detail: busiest
      ? `${formatInteger(readNumber(busiest, 'totalTokens') ?? 0)} tokens`
      : undefined,
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
    { label: 'Events', value: formatInteger(readNumber(data, 'eventCount') ?? 0) },
    { label: 'Sessions', value: formatInteger(readNumber(data, 'sessionCount') ?? 0) },
  );

  return facts;
}

function buildLede(data: Record<string, unknown>, year: string): WrappedView['lede'] {
  const tokens = readNumber(data, 'totalTokens') ?? 0;
  const activeDays = readNumber(data, 'activeDays') ?? 0;
  const cost = readNumber(data, 'costUsd');
  const lede: WrappedView['lede'] = [
    { text: formatAbbreviatedTokenCount(tokens), figure: true },
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
    { text: formatInteger(activeDays), figure: true },
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
    calendar: buildCalendar(
      days,
      (active, count) =>
        `Daily tokens in ${year}: usage on ${pluralize(active, 'day')} of ${formatInteger(count)}. The monthly table holds the totals.`,
    ),
    months: buildMonths(months),
    topLists: [
      buildTopList('Top models', 'Model', readRecords(data.topModels)),
      buildTopList('Top sources', 'Source', readRecords(data.topSources)),
    ].filter((list) => list.items.length > 0),
    note: `From wrapped for ${year}, in ${timezone}. The controls below do not change it.`,
  };
}
