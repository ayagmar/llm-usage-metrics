import { describe, expect, it } from 'vitest';

import { aggregateBlocks, BLOCK_HOURS } from '../../src/blocks/aggregate-blocks.js';
import { computeActiveMs } from '../../src/domain/active-time.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import {
  buildSharePayload,
  type SharePayloadInput,
} from '../../src/share-report/build-share-payload.js';
import { mulberry32, pick, randomInt } from '../helpers/seeded-random.js';

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
  it('counts each capped gap in the cell of the later event', () => {
    // One session over two hours and two models: gaps of 10 (capped to 5), 3 and 2 minutes.
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

    expect(cube.activeMs[cellOf('2026-06-15 10:00', 'claude-sonnet-4-5')]).toBe(0);
    expect(cube.activeMs[cellOf('2026-06-15 11:00', 'gpt-5')]).toBe(7 * MINUTE_MS);
    expect(cube.activeMs[cellOf('2026-06-15 11:00', 'claude-sonnet-4-5')]).toBe(3 * MINUTE_MS);
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

    expect(sum(cube.activeMs)).toBe(expected);
    expect(sum(sessions.rows.map((row) => row.activeMs))).toBe(expected);
    expect(sessions.rows).toHaveLength(bySession.size);
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

  it('stays hourly when the window holds nothing older than 90 days', () => {
    const payload = buildSharePayload(
      payloadInput(events, { windowEnd: '2026-03-20', targetBytes: 1 }),
    );

    expect(payload.hourlyFrom).toBeNull();
  });
});

describe('buildSharePayload sessions', () => {
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
