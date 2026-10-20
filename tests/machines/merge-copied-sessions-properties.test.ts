import { describe, expect, it } from 'vitest';

import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { mergeMachineEvents } from '../../src/machines/merge-machine-events.js';
import { mulberry32, pick, randomInt, shuffle } from '../helpers/seeded-random.js';
import { dedupeCopiedSessions } from '@ayagmar/agent-sessions';

const ITERATIONS = 500;
const SESSIONS = ['a', 'b', 'c'];
const PARSER_VERSIONS = ['n2.p1', 'n2.p2'];
// How a machine stored its events: all before events had ids, all after, or partly each.
const STORAGE = ['legacy', 'current', 'mixed'] as const;

// A request; every request has the same timestamp and usage, so only its ids tell it apart.
function request(sessionId: string, index: number, withIds: boolean): UsageEvent {
  return createUsageEvent({
    source: 'claude',
    sessionId,
    timestamp: '2026-10-01T10:00:00.000Z',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 10,
    ...(withIds ? { messageId: `msg_${index}`, requestId: `req_${index}` } : {}),
  });
}

describe('machine merging and copied-session counting together', () => {
  it('never counts more requests than the machines hold, and all of them when that is knowable', () => {
    const seed = 0x286;
    const random = mulberry32(seed);
    let knowable = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      // Each session made some of the requests or copied them from another session.
      const requestCount = 1 + randomInt(random, 4);
      const requests = Array.from({ length: requestCount }, (_, index) => index + 1);
      const sessionRequests = new Map(
        SESSIONS.map((sessionId) => [
          sessionId,
          shuffle(requests, random).slice(0, 1 + randomInt(random, requestCount)),
        ]),
      );
      // Each machine holds part of some sessions' requests, stored with or without ids.
      const machines = Array.from({ length: 2 + randomInt(random, 3) }, (_, machine) => {
        const storage = pick(random, STORAGE);
        const snapshots = SESSIONS.filter(() => randomInt(random, 3) > 0).map((sessionId) => ({
          sessionId,
          indexes: shuffle(sessionRequests.get(sessionId) ?? [], random).slice(
            randomInt(random, 2),
          ),
        }));

        return {
          name: `machine-${machine}`,
          parserVersions: { claude: pick(random, PARSER_VERSIONS) },
          snapshots,
          events: snapshots.flatMap(({ sessionId, indexes }) =>
            indexes.map((index) =>
              request(
                sessionId,
                index,
                storage === 'current' || (storage === 'mixed' && randomInt(random, 2) === 0),
              ),
            ),
          ),
        };
      });
      const [local, ...remotes] = machines;
      const merged = mergeMachineEvents(local.events, remotes, local.parserVersions);
      const counted = dedupeCopiedSessions([
        ...local.events,
        ...merged.flatMap((machine) => machine.events),
      ]).length;
      const held = new Set(
        machines.flatMap(({ snapshots }) => snapshots.flatMap((s) => s.indexes)),
      );
      const message = `seed ${seed}, iteration ${iteration}`;

      expect(counted, message).toBeLessThanOrEqual(held.size);

      // Every event kept its ids, or one machine's copy of a session holds every request.
      if (
        machines.every(({ events }) => events.every((event) => event.messageId !== undefined)) ||
        machines.some(({ snapshots }) => snapshots.some((s) => s.indexes.length === held.size))
      ) {
        knowable += 1;
        expect(counted, message).toBe(held.size);
      }
    }

    expect(knowable).toBeGreaterThanOrEqual(ITERATIONS / 4);
  });
});
