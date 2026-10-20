import { describe, expect, it } from 'vitest';

import { LOCAL_MACHINE_NAME } from '../../src/config/user-config.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { selectMachines } from '../../src/machines/load-machine-usage.js';
import {
  mergeMachineEvents,
  mergeMachineSessionEvents,
  type ParserVersions,
} from '../../src/machines/merge-machine-events.js';
import {
  createMessageEvent,
  createToolCallEvent,
  dedupeCopiedSessions,
} from '@ayagmar/agent-sessions';

function event(sessionId: string, minute: number): UsageEvent {
  return createUsageEvent({
    source: 'claude',
    sessionId,
    timestamp: new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString(),
    inputTokens: 100,
    outputTokens: 10,
    costMode: 'estimated',
  });
}

describe('mergeMachineEvents', () => {
  const versions = { claude: 'n2.p2' };

  it('leaves out a session copied to another machine, but keeps its later turns', () => {
    const local = [event('s1', 0), event('s1', 1)];
    const [laptop] = mergeMachineEvents(
      local,
      [
        {
          name: 'laptop',
          events: [event('s1', 0), event('s1', 1), event('s1', 2), event('s2', 0)],
          parserVersions: versions,
        },
      ],
      versions,
    );

    expect(laptop.events).toEqual([event('s1', 2), event('s2', 0)]);
    expect(laptop.duplicateCount).toBe(2);
  });

  it('matches each counted event once, so genuine repeats survive', () => {
    const [laptop] = mergeMachineEvents(
      [event('s1', 0)],
      [{ name: 'laptop', events: [event('s1', 0), event('s1', 0)], parserVersions: versions }],
      versions,
    );

    expect(laptop.events).toEqual([event('s1', 0)]);
    expect(laptop.duplicateCount).toBe(1);
  });

  it('checks each machine against everything counted before it', () => {
    const [laptop, vps] = mergeMachineEvents(
      [event('local', 0)],
      [
        {
          name: 'laptop',
          events: [event('local', 0), event('shared', 0)],
          parserVersions: versions,
        },
        {
          name: 'vps',
          events: [event('local', 0), event('shared', 0), event('vps', 0)],
          parserVersions: versions,
        },
      ],
      versions,
    );

    expect(laptop).toMatchObject({ events: [event('shared', 0)], duplicateCount: 1 });
    expect(vps).toMatchObject({ events: [event('vps', 0)], duplicateCount: 2 });
  });

  it('counts a request once when a session stored without ids continues with ids', () => {
    // Two requests in the same millisecond with the same usage, in session a and in b, its
    // continuation. This machine stored a's msg_2 before events had ids.
    function request(sessionId: string, messageId?: string): UsageEvent {
      return createUsageEvent({ ...event(sessionId, 0), messageId });
    }

    const local = [request('a')];
    const [laptop] = mergeMachineEvents(
      local,
      [
        {
          name: 'laptop',
          events: [
            request('a', 'msg_2'),
            request('a', 'msg_1'),
            request('b', 'msg_2'),
            request('b', 'msg_1'),
          ],
          parserVersions: versions,
        },
      ],
      versions,
    );

    expect(dedupeCopiedSessions([...local, ...laptop.events])).toEqual([
      request('a'),
      request('a', 'msg_1'),
    ]);
  });

  it('counts each request once when several sessions hold some of them without ids', () => {
    // Three requests in the same millisecond with the same usage. This machine stored
    // msg_2 and msg_3 of session a before events had ids; the laptop has all of a and c's
    // copies of msg_1 and msg_2; an older vps holds b's copies of all three without ids.
    function request(sessionId: string, messageId?: string): UsageEvent {
      return createUsageEvent({ ...event(sessionId, 0), messageId });
    }

    const local = [request('a'), request('a')];
    const [laptop, vps] = mergeMachineEvents(
      local,
      [
        {
          name: 'laptop',
          events: [
            request('a', 'msg_2'),
            request('a', 'msg_3'),
            request('a', 'msg_1'),
            request('c', 'msg_1'),
            request('c', 'msg_2'),
          ],
          parserVersions: versions,
        },
        {
          name: 'vps',
          events: [request('b'), request('b'), request('b')],
          parserVersions: versions,
        },
      ],
      versions,
    );

    expect(dedupeCopiedSessions([...local, ...laptop.events, ...vps.events])).toEqual([
      request('a'),
      request('a'),
      request('a', 'msg_1'),
    ]);
  });
});

describe('mergeMachineEvents with parser versions', () => {
  // Another parser version splits the same turn's tokens differently.
  function reparsed(sessionId: string, minute: number): UsageEvent {
    return createUsageEvent({ ...event(sessionId, minute), inputTokens: 90, cacheReadTokens: 10 });
  }

  const local = { claude: 'n2.p2' };

  it('drops the turns a differently parsed copy already counts and keeps continuation turns', () => {
    const [laptop] = mergeMachineEvents(
      [event('s1', 0), event('s1', 1)],
      [
        {
          name: 'laptop',
          events: [reparsed('s1', 0), reparsed('s1', 1), reparsed('s1', 2), reparsed('s2', 0)],
          parserVersions: { claude: 'n2.p1' },
        },
      ],
      local,
    );

    expect(laptop).toEqual({
      name: 'laptop',
      events: [reparsed('s1', 2), reparsed('s2', 0)],
      duplicateCount: 0,
      skewDroppedCount: 2,
      skews: [{ source: 'claude', version: 'n2.p1', servedBy: 'local', servedVersion: 'n2.p2' }],
    });
  });

  it('matches a turn whose model another parser resolved differently', () => {
    const [laptop] = mergeMachineEvents(
      [event('s1', 0)],
      [
        {
          name: 'laptop',
          events: [{ ...reparsed('s1', 0), model: 'other-model' }],
          parserVersions: { claude: 'n2.p1' },
        },
      ],
      local,
    );

    expect(laptop).toMatchObject({ events: [], skewDroppedCount: 1 });
  });

  it('keeps a distinct event in the same millisecond as a counted turn', () => {
    const distinct = createUsageEvent({
      ...event('s1', 0),
      model: 'claude-haiku-4-5',
      inputTokens: 100_000,
    });
    const [laptop] = mergeMachineEvents(
      [{ ...event('s1', 0), model: 'claude-sonnet-4-5' }],
      [
        {
          name: 'laptop',
          events: [distinct, { ...reparsed('s1', 0), model: 'claude-sonnet-4-5' }],
          parserVersions: { claude: 'n2.p1' },
        },
      ],
      local,
    );

    expect(laptop).toMatchObject({ events: [distinct], skewDroppedCount: 1 });
  });

  it('matches each counted turn once, so a repeated turn survives', () => {
    const [laptop] = mergeMachineEvents(
      [event('s1', 0)],
      [
        {
          name: 'laptop',
          events: [reparsed('s1', 0), reparsed('s1', 0)],
          parserVersions: { claude: 'n2.p1' },
        },
      ],
      local,
    );

    expect(laptop).toMatchObject({ events: [reparsed('s1', 0)], skewDroppedCount: 1 });
  });

  it('keeps the hash merge when both sides recorded the same version', () => {
    const [laptop] = mergeMachineEvents(
      [event('s1', 0)],
      [{ name: 'laptop', events: [reparsed('s1', 0), event('s1', 0)], parserVersions: local }],
      local,
    );

    expect(laptop).toMatchObject({
      events: [reparsed('s1', 0)],
      duplicateCount: 1,
      skewDroppedCount: 0,
      skews: [],
    });
  });

  it('treats a side that recorded no version as skewed, so an older export does not count twice', () => {
    const variants: [ParserVersions | undefined, ParserVersions | undefined][] = [
      [undefined, local],
      [{ codex: 'n2.p1' }, local],
      [local, undefined],
    ];

    for (const [parserVersions, servedVersions] of variants) {
      const [laptop] = mergeMachineEvents(
        [event('s1', 0)],
        [{ name: 'laptop', events: [reparsed('s1', 0), reparsed('s1', 1)], parserVersions }],
        servedVersions,
      );

      expect(laptop).toMatchObject({
        events: [reparsed('s1', 1)],
        duplicateCount: 0,
        skewDroppedCount: 1,
        skews: [
          {
            source: 'claude',
            version: parserVersions?.claude,
            servedBy: 'local',
            servedVersion: servedVersions?.claude,
          },
        ],
      });
    }
  });

  it('compares a session with the machine that served it first', () => {
    const [laptop, vps] = mergeMachineEvents(
      [],
      [
        { name: 'laptop', events: [event('s1', 0)], parserVersions: { claude: 'n2.p2' } },
        {
          name: 'vps',
          events: [reparsed('s1', 0), reparsed('s1', 1)],
          parserVersions: { claude: 'n2.p1' },
        },
      ],
      local,
    );

    expect(laptop.events).toEqual([event('s1', 0)]);
    expect(vps).toMatchObject({
      events: [reparsed('s1', 1)],
      skewDroppedCount: 1,
      skews: [{ source: 'claude', version: 'n2.p1', servedBy: 'laptop', servedVersion: 'n2.p2' }],
    });
  });

  it('hashes later machines against the turns a skewed machine added', () => {
    const [desk, laptop, vps] = mergeMachineEvents(
      [event('s1', 0)],
      [
        { name: 'desk', events: [event('s1', 0)], parserVersions: local },
        {
          name: 'laptop',
          events: [reparsed('s1', 0), reparsed('s1', 1)],
          parserVersions: { claude: 'n2.p1' },
        },
        { name: 'vps', events: [event('s1', 0), reparsed('s1', 1)], parserVersions: local },
      ],
      local,
    );

    expect(desk).toMatchObject({ events: [], duplicateCount: 1 });
    expect(laptop.events).toEqual([reparsed('s1', 1)]);
    expect(vps).toMatchObject({ events: [], duplicateCount: 2, skewDroppedCount: 0 });
  });
});

describe('mergeMachineSessionEvents', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString();
  const turn = (minute: number, textLength = 5) =>
    createMessageEvent({
      source: 'claude',
      sessionId: 's1',
      timestamp: at(minute),
      role: 'user',
      textLength,
    });
  const call = (minute: number) =>
    createToolCallEvent({
      source: 'claude',
      sessionId: 's1',
      timestamp: at(minute),
      name: 'Bash',
      status: 'ok',
    });

  it('leaves out the turns and calls of a copied session, but keeps new ones', () => {
    const [laptop] = mergeMachineSessionEvents(
      [turn(0), call(1)],
      [{ name: 'laptop', events: [turn(0), call(1), turn(2)] }],
    );

    expect(laptop.events).toEqual([turn(2)]);
  });

  it('under skew, matches each kind on timestamp, so a call at a turn time survives', () => {
    const [laptop] = mergeMachineSessionEvents(
      [turn(0)],
      [{ name: 'laptop', events: [call(0), turn(0, 9)], parserVersions: { claude: 'old' } }],
      { claude: 'new' },
    );

    expect(laptop.events).toEqual([call(0)]);
    expect(laptop.skewDroppedCount).toBe(1);
  });
});

describe('selectMachines', () => {
  const machines = { laptop: { ssh: 'laptop' }, vps: { ssh: 'vps' } };

  it('counts this machine and every configured one by default', () => {
    expect(selectMachines(machines, undefined, { customSourceDirectories: false })).toEqual({
      includeLocal: true,
      names: ['laptop', 'vps'],
    });
  });

  it('leaves other machines out of a run pointed at custom source directories', () => {
    expect(selectMachines(machines, undefined, { customSourceDirectories: true })).toEqual({
      includeLocal: true,
      names: [],
    });
  });

  it('counts only the machines --machine names', () => {
    expect(selectMachines(machines, new Set(['vps']), { customSourceDirectories: true })).toEqual({
      includeLocal: false,
      names: ['vps'],
    });
    expect(
      selectMachines(machines, new Set([LOCAL_MACHINE_NAME]), { customSourceDirectories: false }),
    ).toEqual({ includeLocal: true, names: [] });
  });

  it('rejects names that are not configured', () => {
    expect(() =>
      selectMachines(machines, new Set(['desk']), { customSourceDirectories: false }),
    ).toThrow('Unknown machine(s) for --machine: desk (known: local, laptop, vps)');
  });
});
