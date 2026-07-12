import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getPeriodKey, shiftLocalDateKey } from '../utils/time-buckets.js';
import type { WrappedDay, WrappedMonth, WrappedRecap, WrappedTopItem } from './wrapped-recap.js';

export type AggregateWrappedOptions = {
  year: number;
  timezone: string;
};

type TotalsAccumulator = {
  totalTokens: number;
  costUsd?: number;
  costIncomplete?: boolean;
};

const USD_PRECISION_SCALE = 1_000_000_000_000;

function addUsd(left: number, right: number): number {
  return Math.round((left + right) * USD_PRECISION_SCALE) / USD_PRECISION_SCALE;
}

function toDateKeyRange(year: number): { from: string; to: string } {
  return {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  };
}

function createMonthKeys(year: number): string[] {
  return Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, '0');
    return `${year}-${month}`;
  });
}

function addEventTotals(accumulator: TotalsAccumulator, event: UsageEvent): void {
  accumulator.totalTokens += event.totalTokens;

  if (event.costUsd === undefined) {
    accumulator.costIncomplete = true;
    return;
  }

  accumulator.costUsd = addUsd(accumulator.costUsd ?? 0, event.costUsd);
}

function addGroupedEvent(
  groups: Map<string, TotalsAccumulator>,
  key: string,
  event: UsageEvent,
): void {
  const accumulator = groups.get(key) ?? { totalTokens: 0 };
  addEventTotals(accumulator, event);
  groups.set(key, accumulator);
}

function toWrappedTopItem([name, accumulator]: [string, TotalsAccumulator]): WrappedTopItem {
  return {
    name,
    totalTokens: accumulator.totalTokens,
    costUsd: accumulator.costUsd,
    costIncomplete: accumulator.costIncomplete,
  };
}

function compareTopItems(left: WrappedTopItem, right: WrappedTopItem): number {
  if (left.costUsd !== undefined && right.costUsd === undefined) {
    return -1;
  }

  if (left.costUsd === undefined && right.costUsd !== undefined) {
    return 1;
  }

  if (left.costUsd !== undefined && right.costUsd !== undefined && left.costUsd !== right.costUsd) {
    return right.costUsd - left.costUsd;
  }

  if (left.totalTokens !== right.totalTokens) {
    return right.totalTokens - left.totalTokens;
  }

  return compareByCodePoint(left.name, right.name);
}

const TOP_ITEM_LIMIT = 5;

function toTopItems(groups: Map<string, TotalsAccumulator>): WrappedTopItem[] {
  return [...groups.entries()].map(toWrappedTopItem).sort(compareTopItems).slice(0, TOP_ITEM_LIMIT);
}

function calculateLongestStreak(dateKeys: readonly string[]): number {
  if (dateKeys.length === 0) {
    return 0;
  }

  let longestStreak = 1;
  let currentStreak = 1;

  for (let index = 1; index < dateKeys.length; index += 1) {
    const previous = dateKeys[index - 1] ?? '';
    const current = dateKeys[index] ?? '';

    if (shiftLocalDateKey(previous, 1) === current) {
      currentStreak += 1;
      longestStreak = Math.max(longestStreak, currentStreak);
      continue;
    }

    currentStreak = 1;
  }

  return longestStreak;
}

function toIntensityLevel(totalTokens: number, maxMonthlyTokens: number): WrappedMonth['level'] {
  if (totalTokens <= 0 || maxMonthlyTokens <= 0) {
    return 0;
  }

  const scaledLevel = Math.ceil((totalTokens / maxMonthlyTokens) * 4);

  if (scaledLevel >= 4) {
    return 4;
  }

  if (scaledLevel <= 1) {
    return 1;
  }

  return scaledLevel === 2 ? 2 : 3;
}

function buildMonthlyIntensity(
  monthKeys: readonly string[],
  monthlyTotals: Map<string, TotalsAccumulator>,
): WrappedMonth[] {
  const maxMonthlyTokens = monthKeys.reduce(
    (maxTokens, month) => Math.max(maxTokens, monthlyTotals.get(month)?.totalTokens ?? 0),
    0,
  );

  return monthKeys.map((month) => {
    const accumulator = monthlyTotals.get(month) ?? { totalTokens: 0 };

    return {
      month,
      totalTokens: accumulator.totalTokens,
      costUsd: accumulator.costUsd,
      costIncomplete: accumulator.costIncomplete,
      level: toIntensityLevel(accumulator.totalTokens, maxMonthlyTokens),
    };
  });
}

function createDateKeys(range: { from: string; to: string }): string[] {
  const dateKeys: string[] = [];

  for (let dateKey = range.from; dateKey <= range.to; dateKey = shiftLocalDateKey(dateKey, 1)) {
    dateKeys.push(dateKey);
  }

  return dateKeys;
}

// Quartile banding over active days keeps the heatmap readable when one
// outlier day dwarfs the rest; max-scaling would flatten everything to level 1.
function toDailyLevelThresholds(activeDayTokens: number[]): [number, number, number] {
  const sorted = [...activeDayTokens].sort((left, right) => left - right);
  const quantile = (fraction: number) => sorted[Math.floor(fraction * (sorted.length - 1))] ?? 0;

  return [quantile(0.25), quantile(0.5), quantile(0.75)];
}

function toDailyLevel(
  totalTokens: number,
  thresholds: readonly [number, number, number],
): WrappedDay['level'] {
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

function buildDailyIntensity(
  range: { from: string; to: string },
  dailyTotals: Map<string, TotalsAccumulator>,
): WrappedDay[] {
  const dateKeys = createDateKeys(range);
  const activeDayTokens = dateKeys
    .map((dateKey) => dailyTotals.get(dateKey)?.totalTokens ?? 0)
    .filter((totalTokens) => totalTokens > 0);
  const thresholds = toDailyLevelThresholds(activeDayTokens);

  return dateKeys.map((dateKey) => {
    const totalTokens = dailyTotals.get(dateKey)?.totalTokens ?? 0;

    return {
      date: dateKey,
      totalTokens,
      level: toDailyLevel(totalTokens, thresholds),
    };
  });
}

function isInYearRange(dateKey: string, range: { from: string; to: string }): boolean {
  return dateKey >= range.from && dateKey <= range.to;
}

function getSessionKey(event: UsageEvent): string {
  return `${event.source}\0${event.sessionId}`;
}

export function aggregateWrapped(
  events: readonly UsageEvent[],
  options: AggregateWrappedOptions,
): WrappedRecap {
  const range = toDateKeyRange(options.year);
  const monthKeys = createMonthKeys(options.year);
  const activeDateKeys = new Set<string>();
  const sessionKeys = new Set<string>();
  const modelGroups = new Map<string, TotalsAccumulator>();
  const sourceGroups = new Map<string, TotalsAccumulator>();
  const monthlyTotals = new Map<string, TotalsAccumulator>();
  const dailyTotals = new Map<string, TotalsAccumulator>();
  const total: TotalsAccumulator = { totalTokens: 0 };
  let eventCount = 0;

  for (const event of events) {
    const dateKey = getPeriodKey(event.timestamp, 'daily', options.timezone);

    if (!isInYearRange(dateKey, range)) {
      continue;
    }

    eventCount += 1;
    activeDateKeys.add(dateKey);
    sessionKeys.add(getSessionKey(event));
    addEventTotals(total, event);
    addGroupedEvent(sourceGroups, event.source, event);
    addGroupedEvent(monthlyTotals, dateKey.slice(0, 7), event);
    addGroupedEvent(dailyTotals, dateKey, event);

    if (event.model) {
      addGroupedEvent(modelGroups, event.model, event);
    }
  }

  const sortedDateKeys = [...activeDateKeys].sort(compareByCodePoint);

  return {
    year: options.year,
    timezone: options.timezone,
    from: range.from,
    to: range.to,
    totalTokens: total.totalTokens,
    costUsd: total.costUsd,
    costIncomplete: total.costIncomplete,
    activeDays: activeDateKeys.size,
    longestStreak: calculateLongestStreak(sortedDateKeys),
    eventCount,
    sessionCount: sessionKeys.size,
    topModels: toTopItems(modelGroups),
    topSources: toTopItems(sourceGroups),
    monthlyIntensity: buildMonthlyIntensity(monthKeys, monthlyTotals),
    dailyIntensity: buildDailyIntensity(range, dailyTotals),
  };
}
