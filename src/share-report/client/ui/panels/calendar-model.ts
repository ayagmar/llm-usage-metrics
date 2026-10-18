// The daily calendar wrapped and summary lead with: one cell per day, Monday-first weeks, at
// the heat levels the CLI's `--json` gives each day.

import { MONTH_LABELS } from '../../../../render/month-labels.js';
import { getIsoDayOfWeek, parseDateKey } from '../../../../utils/date-key.js';
import { WEEKDAY_LABELS } from '../../core/index.js';
import { formatDay } from '../shell/format.js';
import { readNumber, readString, type PanelTable } from './model.js';
import { formatInteger } from '../../../../render/format-number.js';

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
  /** One sentence for screen readers; the table holds every day with usage. */
  summary: string;
  /** The days with usage and their tokens: the calendar's table equivalent. */
  table: PanelTable;
};

function clampLevel(level: number | undefined): number {
  return level === undefined ? 0 : Math.min(4, Math.max(0, Math.round(level)));
}

const DAY_MS = 86_400_000;

/**
 * Weeks run Monday to Sunday, as the CLI's ISO weeks; the first column holds the first day.
 * `describe` words the screen-reader summary from the active and listed day counts.
 */
export function buildCalendar(
  days: Record<string, unknown>[],
  describe: (activeDays: number, dayCount: number) => string,
): CalendarView {
  const placed: CalendarDay[] = [];
  const months: CalendarView['months'] = [];
  // The Monday on or before the first day, as a day number; weeks count from it.
  let firstMonday: number | undefined;
  const active: PanelTable['rows'] = [];

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
      active.push([{ text: formatDay(date) }, { text: formatInteger(tokens) }]);
    }

    if (parts.day === 1) {
      months.push({ label: MONTH_LABELS[parts.month - 1], week });
    }

    placed.push({
      week,
      weekday,
      level,
      label: `${formatDay(date)}: ${tokens > 0 ? `${formatInteger(tokens)} tokens` : 'no usage'}`,
    });
  }

  return {
    weeks: Math.max(0, ...placed.map((day) => day.week + 1)),
    days: placed,
    months,
    weekdays: WEEKDAY_LABELS,
    summary: describe(active.length, placed.length),
    table: {
      title: 'Days with usage',
      columns: [
        { label: 'Day', numeric: false },
        { label: 'Tokens', numeric: true },
      ],
      rows: active,
      foot: [],
    },
  };
}
