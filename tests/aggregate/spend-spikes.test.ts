import { describe, expect, it } from 'vitest';

import {
  findSpendSpikes,
  findSpikeDrivers,
  SPIKE_BASELINE_DAYS,
  SPIKE_MIN_ACTIVE_DAYS,
  SPIKE_MIN_COST_USD,
  SPIKE_MIN_MULTIPLE,
} from '../../src/aggregate/spend-spikes.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { getDateKeyRange, shiftDateKey } from '../../src/utils/date-key.js';

/** A small seeded generator, so a failing case can be replayed. */
function createRandom(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const RANGE = { from: '2026-03-01', to: '2026-03-31' };
const ALL_DATES = getDateKeyRange(shiftDateKey(RANGE.from, -SPIKE_BASELINE_DAYS), RANGE.to);

function costsOf(costOf: (date: string, index: number) => number): Map<string, number> {
  return new Map(ALL_DATES.map((date, index) => [date, costOf(date, index)]));
}

describe('findSpendSpikes', () => {
  it('finds no spike when every day costs the same', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const random = createRandom(seed);
      const dailyCost = Math.round(random() * 500 * 100) / 100;

      expect(
        findSpendSpikes(
          costsOf(() => dailyCost),
          RANGE,
        ),
        `seed ${seed}`,
      ).toEqual([]);
    }
  });

  it('finds the one day far above a steady baseline', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const random = createRandom(seed);
      const baseline = 1 + random() * 50;
      const spikeDate = ALL_DATES[SPIKE_BASELINE_DAYS + Math.floor(random() * 31)];
      // Every other day stays within 20% of the baseline; the spike is 3x its ceiling.
      const spikeCost = baseline * 1.2 * SPIKE_MIN_MULTIPLE;
      const costs = costsOf((date) =>
        date === spikeDate ? spikeCost : baseline * (1 + random() * 0.2),
      );

      expect(
        findSpendSpikes(costs, RANGE).map((spike) => spike.date),
        `seed ${seed}`,
      ).toEqual([spikeDate]);
    }
  });

  it('takes the median of the active days among the 28 days before', () => {
    // $1, $2 and $10 on three of the 28 days before Mar 1, nothing on the others: median $2.
    const baseline = new Map([
      [ALL_DATES[0], 1],
      [ALL_DATES[10], 10],
      [ALL_DATES[27], 2],
    ]);
    const on = (costUsd: number) =>
      findSpendSpikes(new Map([...baseline, [RANGE.from, costUsd]]), {
        from: RANGE.from,
        to: RANGE.from,
      });

    expect(on(6)).toEqual([{ date: RANGE.from, costUsd: 6, medianActiveDayUsd: 2 }]);
    expect(on(5.99)).toEqual([]);
  });

  it(`needs ${String(SPIKE_MIN_ACTIVE_DAYS)} active days before a day to call it a spike`, () => {
    const day = { from: RANGE.from, to: RANGE.from };
    const activeDays = (count: number) =>
      new Map([...ALL_DATES.slice(0, count).map((date) => [date, 1] as const), [RANGE.from, 5]]);

    // A sparse user: a $5 day after two $1 days is not a spike, after three it is.
    expect(findSpendSpikes(activeDays(2), day)).toEqual([]);
    expect(findSpendSpikes(activeDays(3), day)).toEqual([
      { date: RANGE.from, costUsd: 5, medianActiveDayUsd: 1 },
    ]);
  });

  it(`never flags a day under $${String(SPIKE_MIN_COST_USD)} or under ${String(SPIKE_MIN_MULTIPLE)}x the median`, () => {
    const day = { from: RANGE.from, to: RANGE.from };

    expect(
      findSpendSpikes(
        costsOf((date) => (date === RANGE.from ? 0.99 : 0.1)),
        day,
      ),
    ).toEqual([]);
    expect(
      findSpendSpikes(
        costsOf((date) => (date === RANGE.from ? 29.99 : 10)),
        day,
      ),
    ).toEqual([]);
    expect(
      findSpendSpikes(
        costsOf((date) => (date === RANGE.from ? 30 : 10)),
        day,
      ),
    ).toHaveLength(1);
  });
});

describe('findSpikeDrivers', () => {
  function event(costUsd: number | undefined, repoRoot: string | undefined, model?: string) {
    return createUsageEvent({
      source: 'codex',
      sessionId: 'session-1',
      timestamp: '2026-03-10T09:00:00.000Z',
      model,
      repoRoot,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costMode: costUsd === undefined ? 'estimated' : 'explicit',
      costUsd,
    });
  }

  it('names the project and the model with the largest share of the cost', () => {
    const labels = new Map<string | undefined, string>([
      ['/work/api', 'api'],
      ['/work/web', 'web'],
      [undefined, '(unattributed)'],
    ]);

    // api costs most over two models; model-a costs most over two projects. An unpriced
    // event weighs nothing.
    expect(
      findSpikeDrivers(
        [
          event(2, '/work/api', 'model-a'),
          event(2, '/work/api/', 'model-b'),
          event(3, '/work/web', 'model-a'),
          event(undefined, '/work/web', 'model-c'),
        ],
        labels,
      ),
    ).toEqual({ project: 'api', model: 'model-a' });
    expect(findSpikeDrivers([event(5, undefined)], labels)).toEqual({
      project: '(unattributed)',
      model: undefined,
    });
  });
});
