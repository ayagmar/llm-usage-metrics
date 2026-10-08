import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import {
  getIsoDayOfWeekFromDateKey,
  getLocalDateKeyRange,
  getPeriodKey,
  shiftLocalDateKey,
} from '../utils/time-buckets.js';
import { addUsd } from '../utils/usd-math.js';

/** Totals of one local day. */
export type DailyTotals = {
  totalTokens: number;
  costUsd?: number;
  costIncomplete?: boolean;
};

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

/** One heatmap cell: a local day and its intensity level (0 = no usage). */
export type ActivityDay = {
  date: string;
  totalTokens: number;
  level: ActivityLevel;
};

export type BusiestDay = DailyTotals & { date: string };

/** Longest run of consecutive days in sorted, de-duplicated local date keys. */
export function calculateLongestStreak(sortedDateKeys: readonly string[]): number {
  if (sortedDateKeys.length === 0) {
    return 0;
  }

  let longestStreak = 1;
  let currentStreak = 1;

  for (let index = 1; index < sortedDateKeys.length; index += 1) {
    if (shiftLocalDateKey(sortedDateKeys[index - 1], 1) === sortedDateKeys[index]) {
      currentStreak += 1;
      longestStreak = Math.max(longestStreak, currentStreak);
      continue;
    }

    currentStreak = 1;
  }

  return longestStreak;
}

/**
 * Consecutive active days ending today. A day without usage yet does not break
 * the streak until it is over, so an inactive today counts back from yesterday.
 */
export function calculateCurrentStreak(activeDateKeys: ReadonlySet<string>, today: string): number {
  let day = activeDateKeys.has(today) ? today : shiftLocalDateKey(today, -1);
  let streak = 0;

  while (activeDateKeys.has(day)) {
    streak += 1;
    day = shiftLocalDateKey(day, -1);
  }

  return streak;
}

/** Day with the most tokens; ties go to the earliest date. */
export function findBusiestDay(
  dailyTotals: ReadonlyMap<string, DailyTotals>,
): BusiestDay | undefined {
  let busiestDay: BusiestDay | undefined;

  for (const [date, totals] of dailyTotals) {
    if (totals.totalTokens <= 0) {
      continue;
    }

    if (
      busiestDay === undefined ||
      totals.totalTokens > busiestDay.totalTokens ||
      (totals.totalTokens === busiestDay.totalTokens && date < busiestDay.date)
    ) {
      busiestDay = {
        date,
        totalTokens: totals.totalTokens,
        costUsd: totals.costUsd,
        costIncomplete: totals.costIncomplete,
      };
    }
  }

  return busiestDay;
}

// Quartile banding over active days keeps the heatmap readable when one
// outlier day dwarfs the rest; max-scaling would flatten everything to level 1.
function toDailyLevelThresholds(positiveValues: number[]): [number, number, number] {
  const sorted = [...positiveValues].sort((left, right) => left - right);
  const quantile = (fraction: number) => sorted[Math.floor(fraction * (sorted.length - 1))] ?? 0;

  return [quantile(0.25), quantile(0.5), quantile(0.75)];
}

function toDailyLevel(
  totalTokens: number,
  thresholds: readonly [number, number, number],
): ActivityLevel {
  if (totalTokens <= 0) {
    return 0;
  }

  if (totalTokens <= thresholds[0]) {
    return 1;
  }

  if (totalTokens <= thresholds[1]) {
    return 2;
  }

  if (totalTokens <= thresholds[2]) {
    return 3;
  }

  return 4;
}

/** Intensity level of each value: 0 when not positive, else 1-4 by quartile of the positive values. */
export function toActivityLevels(values: readonly number[]): ActivityLevel[] {
  const thresholds = toDailyLevelThresholds(values.filter((value) => value > 0));
  return values.map((value) => toDailyLevel(value, thresholds));
}

/** Every day from `from` to `to` (inclusive) with its quartile intensity level. */
export function buildDailyIntensity(
  range: { from: string; to: string },
  dailyTotals: ReadonlyMap<string, DailyTotals>,
): ActivityDay[] {
  const dateKeys = getLocalDateKeyRange(range.from, range.to);
  const tokens = dateKeys.map((dateKey) => dailyTotals.get(dateKey)?.totalTokens ?? 0);
  const levels = toActivityLevels(tokens);

  return dateKeys.map((dateKey, index) => ({
    date: dateKey,
    totalTokens: tokens[index],
    level: levels[index],
  }));
}

export type DailyActivity = {
  from: string;
  to: string;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  bestDay?: BusiestDay;
  days: ActivityDay[];
};

const ACTIVITY_WEEKS = 53;

/** First day of a GitHub-style grid: the Monday 52 weeks before the week of `today`. */
export function resolveActivityStart(today: string): string {
  const daysSinceMonday = getIsoDayOfWeekFromDateKey(today) - 1;
  return shiftLocalDateKey(today, -(daysSinceMonday + (ACTIVITY_WEEKS - 1) * 7));
}

/** Streaks, best day, and heatmap levels for events from `from` to `to` (inclusive). */
export function aggregateDailyActivity(
  events: readonly UsageEvent[],
  options: { from: string; to: string; timezone: string },
): DailyActivity {
  const dailyTotals = new Map<string, DailyTotals>();

  for (const event of events) {
    const date = getPeriodKey(event.timestamp, 'daily', options.timezone);

    if (date < options.from || date > options.to) {
      continue;
    }

    const totals = dailyTotals.get(date) ?? { totalTokens: 0 };
    totals.totalTokens += event.totalTokens;

    if (event.costUsd === undefined) {
      totals.costIncomplete = true;
    } else {
      totals.costUsd = addUsd(totals.costUsd ?? 0, event.costUsd);
    }

    dailyTotals.set(date, totals);
  }

  const activeDateKeys = new Set(dailyTotals.keys());

  return {
    from: options.from,
    to: options.to,
    activeDays: activeDateKeys.size,
    currentStreak: calculateCurrentStreak(activeDateKeys, options.to),
    longestStreak: calculateLongestStreak([...activeDateKeys].sort(compareByCodePoint)),
    bestDay: findBusiestDay(dailyTotals),
    days: buildDailyIntensity(options, dailyTotals),
  };
}
