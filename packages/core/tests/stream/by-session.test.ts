import { describe, expect, expectTypeOf, it } from 'vitest';

import { createUsageRecord, type UsageRecord } from '../../src/domain/session-event.js';
import { bySession, type SessionGroup } from '../../src/stream/by-session.js';
import { collect } from '../../src/stream/collect.js';
import { pipe } from '../../src/stream/pipe.js';
import { mulberry32, pick, randomInt } from '../helpers/seeded-random.js';

const ITERATIONS = 200;
const SOURCES = ['pi', 'claude'];
// The same session id under two sources, so grouping must key on both.
const SESSION_IDS = ['a', 'b', 'c'];

async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  yield* items;
}

function usage(source: string, sessionId: string, index: number): UsageRecord {
  return createUsageRecord({
    source,
    sessionId,
    timestamp: '2026-06-01T10:00:00.000Z',
    inputTokens: index,
  });
}

const sessionKey = (event: UsageRecord) => `${event.source}/${event.sessionId}`;

describe('bySession', () => {
  it('flattens back to the input stably sorted by first-seen session', async () => {
    const seed = 0x5eed_0611;
    const random = mulberry32(seed);
    let interleaved = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const events = Array.from({ length: randomInt(random, 15) }, (_, index) =>
        usage(pick(random, SOURCES), pick(random, SESSION_IDS), index),
      );
      const firstSeen = [...new Set(events.map(sessionKey))];
      const expected = [...events].sort(
        (left, right) => firstSeen.indexOf(sessionKey(left)) - firstSeen.indexOf(sessionKey(right)),
      );
      const groups = await collect(bySession<UsageRecord>()(fromArray(events)));
      const message = `seed ${seed}, iteration ${iteration}`;

      expect(
        groups.flatMap((group) => group.events),
        message,
      ).toEqual(expected);
      expect(
        groups.map((group) => `${group.source}/${group.sessionId}`),
        message,
      ).toEqual(firstSeen);

      for (const group of groups) {
        expect(
          group.events.every((event) => sessionKey(event) === `${group.source}/${group.sessionId}`),
          message,
        ).toBe(true);
      }

      interleaved += expected.some((event, index) => event !== events[index]) ? 1 : 0;
    }

    expect(interleaved).toBeGreaterThanOrEqual(50);
  });

  it('yields nothing for an empty stream', async () => {
    await expect(collect(bySession()(fromArray([])))).resolves.toEqual([]);
  });

  it('types each group with the stream event type', async () => {
    const groups = await collect(pipe(fromArray([usage('pi', 'a', 0)]), bySession()));

    expectTypeOf(groups).toEqualTypeOf<SessionGroup<UsageRecord>[]>();
  });
});
