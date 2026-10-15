import { describe, expect, expectTypeOf, it } from 'vitest';

import { createUsageRecord, type UsageRecord } from '../../src/domain/session-event.js';
import { collect } from '../../src/stream/collect.js';
import { pipe } from '../../src/stream/pipe.js';
import { since, until } from '../../src/stream/window.js';
import { mulberry32, pick, randomInt } from '../helpers/seeded-random.js';

const ITERATIONS = 200;

// Instants around the 9999/10000 boundary too, where ISO strings stop ordering as
// instants: `+010000-...` sorts before `9999-...` as text.
const INSTANTS = [
  '2026-06-01T10:00:00.000Z',
  '2026-06-01T10:00:00.001Z',
  '2026-06-02T00:00:00.000Z',
  '9999-12-31T23:59:59.999Z',
  '+010000-01-01T00:00:00.000Z',
  '+010000-01-02T00:00:00.000Z',
];

function usageAt(timestamp: string, sessionId = 's'): UsageRecord {
  return createUsageRecord({ source: 'pi', sessionId, timestamp, inputTokens: 1 });
}

async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  yield* items;
}

function positionsIn<T>(input: readonly T[], output: readonly T[]): number[] {
  return output.map((item) => input.indexOf(item));
}

describe('since and until', () => {
  it('split a stream in two at any bound, each part in input order', async () => {
    const seed = 0x5eed_0610;
    const random = mulberry32(seed);
    let splitBoth = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const events = Array.from({ length: randomInt(random, 12) }, (_, index) =>
        usageAt(pick(random, INSTANTS), `s${index}`),
      );
      const instant = pick(random, INSTANTS);
      const bound = random() < 0.5 ? instant : new Date(Date.parse(instant));
      const after = positionsIn(events, await collect(since(bound)(fromArray(events))));
      const before = positionsIn(events, await collect(until(bound)(fromArray(events))));
      const message = `seed ${seed}, iteration ${iteration}`;

      expect(
        [...after, ...before].sort((left, right) => left - right),
        message,
      ).toEqual(events.map((_, index) => index));
      expect(
        after.filter((position) => before.includes(position)),
        message,
      ).toEqual([]);
      expect(after, message).toEqual([...after].sort((left, right) => left - right));
      expect(before, message).toEqual([...before].sort((left, right) => left - right));

      splitBoth += after.length > 0 && before.length > 0 ? 1 : 0;
    }

    expect(splitBoth).toBeGreaterThanOrEqual(50);
  });

  it('keeps an event at the bound in since and out of until', async () => {
    const event = usageAt('2026-06-01T10:00:00.000Z');

    await expect(collect(since(event.timestamp)(fromArray([event])))).resolves.toEqual([event]);
    await expect(collect(until(event.timestamp)(fromArray([event])))).resolves.toEqual([]);
  });

  it('compares instants, not strings, past year 9999', async () => {
    const events = [usageAt('9999-12-31T23:59:59.999Z'), usageAt('+010000-01-01T00:00:00.000Z')];

    await expect(collect(since('+010000-01-01T00:00:00.000Z')(fromArray(events)))).resolves.toEqual(
      [events[1]],
    );
    await expect(collect(until('+010000-01-01T00:00:00.000Z')(fromArray(events)))).resolves.toEqual(
      [events[0]],
    );
  });

  it('reads a bound with an offset as the instant it names', async () => {
    const events = [usageAt('2026-06-01T07:59:59.999Z'), usageAt('2026-06-01T08:00:00.000Z')];

    await expect(collect(since('2026-06-01T10:00:00+02:00')(fromArray(events)))).resolves.toEqual([
      events[1],
    ]);
  });

  it('throws on an invalid bound when the stage is created, not when it runs', () => {
    expect(() => since('not a date')).toThrow('since: invalid date "not a date"');
    expect(() => until(new Date(Number.NaN))).toThrow('until: invalid date');
  });

  it('rejects a string bound with a time but no UTC offset, which would depend on TZ', () => {
    for (const bound of ['2026-06-01T10:00', '2026-06-01T10:00:00.000', '2026-06-01 10:00']) {
      expect(() => since(bound)).toThrow(
        `since: ${JSON.stringify(bound)} has a time but no UTC offset`,
      );
      expect(() => until(bound)).toThrow('until:');
    }

    for (const bound of [
      '2026-06-01',
      '2026-06-01T10:00Z',
      '2026-06-01T10:00:00.000+0200',
      '2026-06-01T10:00:00-05:00',
      'Mon, 01 Jun 2026 10:00:00 GMT',
      'Mon Jun 01 2026 10:00:00 GMT+0200 (Central European Summer Time)',
    ]) {
      expect(() => since(bound)).not.toThrow();
    }
  });

  it('reads a date-only bound as midnight UTC', async () => {
    const events = [usageAt('2026-05-31T23:59:59.999Z'), usageAt('2026-06-01T00:00:00.000Z')];

    await expect(collect(since('2026-06-01')(fromArray(events)))).resolves.toEqual([events[1]]);
  });

  it('drops an event whose timestamp does not parse, from both sides', async () => {
    const events = [{ timestamp: 'not a time' }, { timestamp: '2026-06-01T10:00:00.000Z' }];
    const bound = '2026-06-01T00:00:00.000Z';

    await expect(collect(since(bound)(fromArray(events)))).resolves.toEqual([events[1]]);
    await expect(collect(until(bound)(fromArray(events)))).resolves.toEqual([]);
  });

  it('keep the stream type through pipe', async () => {
    const kept = await collect(
      pipe(
        fromArray([usageAt('2026-06-01T10:00:00.000Z')]),
        since('2026-06-01T00:00:00.000Z'),
        until('2026-06-02T00:00:00.000Z'),
      ),
    );

    expectTypeOf(kept).toEqualTypeOf<UsageRecord[]>();
  });
});
