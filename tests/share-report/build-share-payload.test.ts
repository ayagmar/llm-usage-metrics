import { describe, expect, it } from 'vitest';

import { aggregateBlocks, BLOCK_HOURS } from '../../src/blocks/aggregate-blocks.js';
import { computeActiveMs, computeUnionActiveMs } from '@ayagmar/agent-sessions';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import {
  buildSharePayload,
  listShareSizeWarnings,
  type SharePayloadInput,
} from '../../src/share-report/build-share-payload.js';
import { mulberry32, pick, randomInt } from '../helpers/seeded-random.js';
import { toShareModelLabel } from '../../src/share-report/redact.js';

const MINUTE_MS = 60_000;

function event(
  overrides: Partial<Parameters<typeof createUsageEvent>[0]> & { machine?: string } = {},
): UsageEvent {
  const { machine, ...input } = overrides;
  const created = createUsageEvent({
    source: 'claude',
    sessionId: 's1',
    timestamp: '2026-06-15T10:00:00.000Z',
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 10,
    ...input,
  });

  return machine === undefined ? created : { ...created, machine };
}

function at(minutes: number, base = '2026-06-15T10:00:00.000Z'): string {
  return new Date(Date.parse(base) + minutes * MINUTE_MS).toISOString();
}

function payloadInput(
  events: readonly UsageEvent[],
  overrides: Partial<SharePayloadInput> = {},
): SharePayloadInput {
  const costs = { explicit: events.map((item) => item.costUsd) };

  return {
    events,
    costs,
    timezone: 'UTC',
    sourceOrder: ['claude', 'codex'],
    projectLabel: (repoRoot) => repoRoot?.split('/').at(-1) ?? '(unattributed)',
    machineLabel: (machine) => machine,
    modelLabel: toShareModelLabel,
    blocks: aggregateBlocks([...events]),
    blockEvents: events,
    blockCosts: costs,
    blockHours: BLOCK_HOURS,
    windowEnd: '2026-06-30',
    ...overrides,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('buildSharePayload active time', () => {
  it('counts each active gap in the cell of the later event, and none over the cap', () => {
    // One session over two hours and two models: gaps of 10 (over the cap), 3 and 2 minutes.
    const events = [
      event({ timestamp: at(50) }),
      event({ timestamp: at(60), model: 'gpt-5' }),
      event({ timestamp: at(63) }),
      event({ timestamp: at(65), model: 'gpt-5' }),
    ];
    const { cube, dictionaries } = buildSharePayload(payloadInput(events));
    const cellOf = (period: string, model: string) =>
      cube.period.findIndex(
        (periodIndex, cell) =>
          dictionaries.periods[periodIndex] === period &&
          dictionaries.models[cube.model[cell]] === model,
      );

    expect(cube.agentMs[cellOf('2026-06-15 10:00', 'claude-sonnet-4-5')]).toBe(0);
    expect(cube.agentMs[cellOf('2026-06-15 11:00', 'gpt-5')]).toBe(2 * MINUTE_MS);
    expect(cube.agentMs[cellOf('2026-06-15 11:00', 'claude-sonnet-4-5')]).toBe(3 * MINUTE_MS);
  });

  it('sums over any dimension to each session’s active time', () => {
    const random = mulberry32(7);
    const events = Array.from({ length: 300 }, () =>
      event({
        source: pick(random, ['claude', 'codex']),
        sessionId: `s${String(randomInt(random, 12))}`,
        timestamp: at(randomInt(random, 3 * 24 * 60)),
        model: pick(random, ['claude-sonnet-4-5', 'gpt-5', undefined]),
        repoRoot: pick(random, ['/w/a', '/w/b', undefined]),
        machine: pick(random, [undefined, 'laptop']),
      }),
    );
    const { cube, sessions } = buildSharePayload(payloadInput(events));
    const bySession = new Map<string, number[]>();

    for (const item of events) {
      const key = `${item.source}\0${item.sessionId}`;
      bySession.set(key, [...(bySession.get(key) ?? []), Date.parse(item.timestamp)]);
    }

    const expected = sum([...bySession.values()].map((times) => computeActiveMs(times)));

    expect(sum(cube.agentMs)).toBe(expected);
    expect(sum(sessions.rows.map((row) => row.agentMs))).toBe(expected);
    expect(sessions.rows).toHaveLength(bySession.size);
  });
});

describe('buildSharePayload wall-clock active time', () => {
  const periodMs = (payload: ReturnType<typeof buildSharePayload>) =>
    Object.fromEntries(
      payload.dictionaries.periods.map((key, index) => [key, payload.cube.periodActiveMs[index]]),
    );

  it('counts parallel sessions once per period while Agent time adds them', () => {
    const events = ['a', 'b'].flatMap((sessionId) => [
      event({ sessionId, timestamp: at(0) }),
      event({ sessionId, timestamp: at(4) }),
    ]);
    const payload = buildSharePayload(payloadInput(events));

    expect(sum(payload.cube.periodActiveMs)).toBe(4 * MINUTE_MS);
    expect(sum(payload.cube.agentMs)).toBe(8 * MINUTE_MS);
  });

  it('splits a gap across an hour boundary, in Agent time as well', () => {
    const payload = buildSharePayload(
      payloadInput([event({ timestamp: at(58) }), event({ timestamp: at(63), model: 'gpt-5' })]),
    );

    expect(periodMs(payload)).toEqual({
      '2026-06-15 10:00': 2 * MINUTE_MS,
      '2026-06-15 11:00': 3 * MINUTE_MS,
    });
    expect([...payload.cube.agentMs]).toEqual([2 * MINUTE_MS, 3 * MINUTE_MS]);
  });

  it('splits at local midnight in a half-hour timezone', () => {
    // 18:30 UTC is midnight in Asia/Kolkata.
    const payload = buildSharePayload(
      payloadInput(
        [
          event({ timestamp: '2026-06-15T18:28:00.000Z' }),
          event({ timestamp: '2026-06-15T18:32:00.000Z' }),
        ],
        { timezone: 'Asia/Kolkata' },
      ),
    );

    expect(periodMs(payload)).toEqual({
      '2026-06-15 23:00': 2 * MINUTE_MS,
      '2026-06-16 00:00': 2 * MINUTE_MS,
    });
  });

  it('splits a gap across hourlyFrom between the last daily and first hourly period', () => {
    const payload = buildSharePayload(
      payloadInput(
        [
          event({ timestamp: '2026-03-31T23:58:00.000Z' }),
          event({ timestamp: '2026-04-01T00:03:00.000Z' }),
        ],
        { timezone: 'UTC', windowEnd: '2026-06-30', targetBytes: 1 },
      ),
    );

    expect(payload.hourlyFrom).toBe('2026-04-01');
    expect(periodMs(payload)).toEqual({
      '2026-03-31': 2 * MINUTE_MS,
      '2026-04-01 00:00': 3 * MINUTE_MS,
    });
    expect([...payload.cube.agentMs]).toEqual([2 * MINUTE_MS, 3 * MINUTE_MS]);
  });

  it('keeps every period within its Agent time and the file on the union', () => {
    const random = mulberry32(11);
    const events = Array.from({ length: 400 }, () =>
      event({
        source: pick(random, ['claude', 'codex']),
        sessionId: `s${String(randomInt(random, 10))}`,
        // Across the 2026-10-25 fall-back in Paris.
        timestamp: new Date(
          Date.UTC(2026, 9, 24, 12) + randomInt(random, 48 * 60) * MINUTE_MS,
        ).toISOString(),
        model: pick(random, ['claude-sonnet-4-5', 'gpt-5']),
      }),
    );
    const payload = buildSharePayload(
      payloadInput(events, { timezone: 'Europe/Paris', windowEnd: '2026-10-26' }),
    );
    const { cube, dictionaries } = payload;
    const bySession = new Map<string, number[]>();

    for (const item of events) {
      const key = `${item.source}\0${item.sessionId}`;
      bySession.set(key, [...(bySession.get(key) ?? []), Date.parse(item.timestamp)]);
    }

    expect(sum(cube.periodActiveMs)).toBe(computeUnionActiveMs(bySession.values()));

    const agentByPeriod = dictionaries.periods.map(() => 0);
    const activeByDay = new Map<string, number>();

    cube.agentMs.forEach((ms, cell) => {
      agentByPeriod[cube.period[cell]] += ms;
    });
    dictionaries.periods.forEach((key, index) => {
      expect(cube.periodActiveMs[index]).toBeLessThanOrEqual(agentByPeriod[index]);
      const day = key.slice(0, 10);
      activeByDay.set(day, (activeByDay.get(day) ?? 0) + cube.periodActiveMs[index]);
    });

    for (const [day, ms] of activeByDay) {
      // The fall-back day really lasts 25 hours.
      expect(ms).toBeLessThanOrEqual((day === '2026-10-25' ? 25 : 24) * 60 * MINUTE_MS);
    }
  });
});

describe('buildSharePayload cells', () => {
  it('keeps one key for the repeated hour when clocks go back', () => {
    // 2026-10-25 in Paris: 02:00–03:00 happens at +02:00 and again at +01:00.
    const events = [
      event({ timestamp: '2026-10-25T00:30:00.000Z' }),
      event({ timestamp: '2026-10-25T01:30:00.000Z' }),
    ];
    const { dictionaries, cube } = buildSharePayload(
      payloadInput(events, { timezone: 'Europe/Paris' }),
    );

    expect(dictionaries.periods).toEqual(['2026-10-25 02:00']);
    expect(cube.eventCount).toEqual([2]);
  });

  it('marks a cell incomplete per mode and leaves its cost null when no event has one', () => {
    const events = [
      event({ costUsd: 0.25, costMode: 'explicit' }),
      event({ timestamp: at(1) }),
      event({ timestamp: at(2), source: 'codex', model: 'gpt-5' }),
    ];
    const { cube } = buildSharePayload(payloadInput(events));

    expect(cube.costs.explicit).toEqual({ costUsd: [0.25, null], incompleteEvents: [1, 1] });
    expect(Object.keys(cube.costs)).toEqual(['explicit']);
  });

  it('holds no cost columns without costs (--no-cost)', () => {
    const events = [event()];
    const { cube, sessions, blocks } = buildSharePayload(
      payloadInput(events, { costs: {}, blockCosts: {} }),
    );

    expect(cube.costs).toEqual({});
    expect(sessions.rows[0].costs).toEqual({});
    expect(blocks.rows[0].costs).toEqual({});
  });
});

describe('buildSharePayload size guard', () => {
  const events = Array.from({ length: 200 }, (_, index) =>
    event({
      timestamp: at(index * 60, '2026-03-01T00:00:00.000Z'),
      sessionId: `s${String(index)}`,
    }),
  );

  it('keeps every cell hourly under the target', () => {
    const payload = buildSharePayload(payloadInput(events));

    expect(payload.hourlyFrom).toBeNull();
    expect(payload.dictionaries.periods.every((key) => key.length === 16)).toBe(true);
  });

  it('rolls cells older than 90 days before the window end up to days over the target', () => {
    const hourly = buildSharePayload(payloadInput(events));
    const payload = buildSharePayload(
      payloadInput(events, { windowEnd: '2026-06-05', targetBytes: hourly.bytes - 1 }),
    );

    expect(payload.hourlyFrom).toBe('2026-03-07');
    expect(payload.dictionaries.periods.filter((key) => key < '2026-03-07')).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
    ]);
    expect(payload.dictionaries.periods.filter((key) => key >= '2026-03-07')).toSatisfy(
      (keys: string[]) => keys.length > 0 && keys.every((key) => key.length === 16),
    );
    expect(payload.bytes).toBeLessThan(hourly.bytes);
    expect(sum(payload.cube.totalTokens)).toBe(sum(hourly.cube.totalTokens));
    expect(sum(payload.cube.eventCount)).toBe(events.length);
  });

  it('measures the payload as the file holds it, after script escaping', () => {
    // Each `<` is six bytes in the file, so the escaped payload outgrows the raw JSON.
    const tagged = events.map((item) => ({ ...item, model: `${'<'.repeat(500)}model` }));
    const hourly = buildSharePayload(payloadInput(tagged, { windowEnd: '2026-06-05' }));
    const { dictionaries, cube, sessions, blocks } = hourly;
    const rawBytes = Buffer.byteLength(JSON.stringify({ dictionaries, cube, sessions, blocks }));

    const payload = buildSharePayload(
      payloadInput(tagged, { windowEnd: '2026-06-05', targetBytes: rawBytes }),
    );

    expect(payload.hourlyFrom).toBe('2026-03-07');
  });

  it('stays hourly when the window holds nothing older than 90 days', () => {
    const payload = buildSharePayload(
      payloadInput(events, { windowEnd: '2026-03-20', targetBytes: 1 }),
    );

    expect(payload.hourlyFrom).toBeNull();
  });
});

describe('listShareSizeWarnings', () => {
  it('says nothing for an hourly file under the target', () => {
    expect(listShareSizeWarnings({ hourlyFrom: null, htmlBytes: 7_900_000 })).toEqual([]);
  });

  it('says where hourly detail starts and when the file is still over the target', () => {
    expect(listShareSizeWarnings({ hourlyFrom: '2026-03-07', htmlBytes: 9_140_000 })).toEqual([
      'Share report: hourly detail from 2026-03-07; earlier usage is by day to keep the file small.',
      'Share report: the file is 9.1 MB, over the 8 MB target; a shorter window or narrower filters make it smaller.',
    ]);
  });
});

describe('buildSharePayload sessions', () => {
  it('lists a session under the root of its earliest event, as session does', () => {
    // Read out of order: the later event, logged outside the root, comes first.
    const events = [
      event({ timestamp: at(5), repoRoot: '/w/other' }),
      event({ timestamp: at(0), repoRoot: '/w/app' }),
    ];
    const { sessions, dictionaries } = buildSharePayload(payloadInput(events));

    expect(sessions.rows.map((row) => dictionaries.projects[row.project])).toEqual(['app']);
  });

  it('keeps the newest sessions per project and counts the rest', () => {
    const events = [
      ...Array.from({ length: 5 }, (_, index) =>
        event({ sessionId: `a${String(index)}`, timestamp: at(index * 10), repoRoot: '/w/a' }),
      ),
      event({ sessionId: 'b0', timestamp: at(100), repoRoot: '/w/b' }),
    ];
    const { sessions, dictionaries } = buildSharePayload(
      payloadInput(events, { sessionsPerProject: 2 }),
    );

    expect(sessions.rows.map((row) => row.firstActivityAt)).toEqual([at(100), at(40), at(30)]);
    expect(sessions.omitted).toEqual([{ project: dictionaries.projects.indexOf('a'), count: 3 }]);
  });

  it('labels sessions by source and local start, numbering collisions, never by session ID', () => {
    const events = [
      event({ sessionId: 'secret-one', timestamp: '2026-06-15T10:05:10.000Z' }),
      event({ sessionId: 'secret-two', timestamp: '2026-06-15T10:05:40.000Z' }),
      event({ sessionId: 'secret-three', source: 'codex', timestamp: '2026-06-15T10:05:00.000Z' }),
    ];
    const { sessions } = buildSharePayload(payloadInput(events, { timezone: 'Asia/Kathmandu' }));

    expect(sessions.rows.map((row) => row.label)).toEqual([
      'claude · 2026-06-15 15:50 #2',
      'claude · 2026-06-15 15:50',
      'codex · 2026-06-15 15:50',
    ]);
    expect(JSON.stringify(sessions)).not.toContain('secret');
  });

  it('takes the project of the first root seen and every machine of the session', () => {
    const events = [
      event({ timestamp: at(0) }),
      event({ timestamp: at(1), repoRoot: '/w/a', machine: 'laptop' }),
      event({ timestamp: at(2), repoRoot: '/w/b' }),
    ];
    const { sessions, dictionaries } = buildSharePayload(payloadInput(events));
    const [row] = sessions.rows;

    expect(dictionaries.projects[row.project]).toBe('a');
    expect(row.machines.map((index) => dictionaries.machines[index]).sort()).toEqual([
      'laptop',
      'local',
    ]);
  });
});

describe('buildSharePayload blocks', () => {
  it('costs each block from its own events, lookback events included only in kept blocks', () => {
    const lookback = event({
      timestamp: '2026-06-10T08:00:00.000Z',
      costUsd: 9,
      costMode: 'explicit',
    });
    const kept = [
      event({ timestamp: '2026-06-14T22:30:00.000Z', costUsd: 1, costMode: 'explicit' }),
      event({ timestamp: '2026-06-15T01:00:00.000Z', costUsd: 2, costMode: 'explicit' }),
      event({ timestamp: '2026-06-15T09:00:00.000Z', costUsd: 4, costMode: 'explicit' }),
    ];
    const blockEvents = [lookback, ...kept];
    const blocks = aggregateBlocks(blockEvents, {
      sinceMs: Date.parse('2026-06-15T00:00:00.000Z'),
      rangeStartMs: Date.parse('2026-06-08T00:00:00.000Z'),
    });
    const windowEvents = kept.slice(1);
    const { blocks: shareBlocks } = buildSharePayload(
      payloadInput(windowEvents, {
        blocks,
        blockEvents,
        blockCosts: { explicit: blockEvents.map((item) => item.costUsd) },
      }),
    );

    expect(shareBlocks.rows.map((row) => [row.start, row.costs.explicit?.costUsd])).toEqual([
      ['2026-06-14T22:00:00.000Z', 3],
      ['2026-06-15T09:00:00.000Z', 4],
    ]);
  });
});
