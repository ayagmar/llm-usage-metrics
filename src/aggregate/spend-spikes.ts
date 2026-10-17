import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getLocalDateKeyRange, shiftLocalDateKey } from '../utils/time-buckets.js';
import { addUsd } from '../utils/usd-math.js';
import { toProjectKey } from './project-key.js';

/** A spike costs at least this many times the median day before it. */
export const SPIKE_MIN_MULTIPLE = 3;

/** A day under this cost is never a spike, which keeps cents-a-day usage quiet. */
export const SPIKE_MIN_COST_USD = 1;

/** How many days before a day its median covers. */
export const SPIKE_BASELINE_DAYS = 28;

/** A day whose cost is a spike against the median of the days before it. */
export type SpendSpike = {
  date: string;
  costUsd: number;
  /** Median daily cost of the 28 days before; days without usage count as 0. */
  medianUsd: number;
};

/** The first day the spike check of days from `from` on needs a cost for. */
export function resolveSpikeBaselineStart(from: string): string {
  return shiftLocalDateKey(from, -SPIKE_BASELINE_DAYS);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The spike days from `range.from` to `range.to`. `dailyCostUsd` holds each day's cost from
 * `resolveSpikeBaselineStart(range.from)` on; a day it lacks cost nothing.
 */
export function findSpendSpikes(
  dailyCostUsd: ReadonlyMap<string, number>,
  range: { from: string; to: string },
): SpendSpike[] {
  const dates = getLocalDateKeyRange(resolveSpikeBaselineStart(range.from), range.to);
  const costs = dates.map((date) => dailyCostUsd.get(date) ?? 0);
  const spikes: SpendSpike[] = [];

  for (let index = SPIKE_BASELINE_DAYS; index < dates.length; index += 1) {
    const costUsd = costs[index];

    if (costUsd < SPIKE_MIN_COST_USD) {
      continue;
    }

    const medianUsd = median(costs.slice(index - SPIKE_BASELINE_DAYS, index));

    if (costUsd >= SPIKE_MIN_MULTIPLE * medianUsd) {
      spikes.push({ date: dates[index], costUsd, medianUsd });
    }
  }

  return spikes;
}

/**
 * The key with the largest summed cost, ties to the first by code point; undefined when no
 * event has a cost.
 */
function findLargestCostKey<Key extends string | undefined>(
  events: readonly UsageEvent[],
  keyOf: (event: UsageEvent) => Key,
): { key: Key } | undefined {
  const costByKey = new Map<Key, number>();

  for (const event of events) {
    if (event.costUsd !== undefined) {
      const key = keyOf(event);
      costByKey.set(key, addUsd(costByKey.get(key) ?? 0, event.costUsd));
    }
  }

  let largest: [Key, number] | undefined;

  for (const entry of costByKey) {
    if (
      largest === undefined ||
      entry[1] > largest[1] ||
      (entry[1] === largest[1] && compareByCodePoint(entry[0] ?? '', largest[0] ?? '') < 0)
    ) {
      largest = entry;
    }
  }

  return largest && { key: largest[0] };
}

/**
 * The project and the model with the largest share of a day's cost. `projectLabels` labels
 * every project key of the events; the model is absent when the costliest events name none.
 */
export function findSpikeDrivers(
  dayEvents: readonly UsageEvent[],
  projectLabels: ReadonlyMap<string | undefined, string>,
): { project?: string; model?: string } {
  const project = findLargestCostKey(dayEvents, (event) => toProjectKey(event.repoRoot));

  return {
    project: project && projectLabels.get(project.key),
    model: findLargestCostKey(dayEvents, (event) => event.model)?.key,
  };
}
