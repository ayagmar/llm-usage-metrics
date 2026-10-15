import { describe, expect, it } from 'vitest';

import {
  aggregateBlocks,
  BLOCK_DURATION_MS,
  computeBurnRate,
  isBlockActive,
  resolveBlockRanking,
  selectTopBlocks,
  type UsageBlock,
} from '../../src/blocks/aggregate-blocks.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function event(
  timestamp: string,
  overrides: Partial<{
    source: string;
    machine: string;
    costUsd: number;
    tokens: number;
    model: string;
  }> = {},
): UsageEvent {
  const created = createUsageEvent({
    source: overrides.source ?? 'claude',
    sessionId: 's',
    timestamp,
    model: overrides.model ?? 'claude-sonnet-4-5',
    provider: 'anthropic',
    inputTokens: overrides.tokens ?? 100,
    outputTokens: 0,
    costUsd: overrides.costUsd,
  });

  return overrides.machine === undefined ? created : { ...created, machine: overrides.machine };
}

function spans(blocks: readonly UsageBlock[]): string[] {
  return blocks.map((block) => `${block.source} ${block.start} ${block.end} ${block.eventCount}`);
}

describe('aggregateBlocks', () => {
  it('starts a block at the UTC hour floor of its first event and ends it 5 h later', () => {
    const [block] = aggregateBlocks([event('2026-06-15T09:10:00.000Z')]);

    expect(block).toMatchObject({
      start: '2026-06-15T09:00:00.000Z',
      end: '2026-06-15T14:00:00.000Z',
      firstEventAt: '2026-06-15T09:10:00.000Z',
      lastEventAt: '2026-06-15T09:10:00.000Z',
      startUncertain: false,
    });
  });

  it('ends a block exclusively: an event exactly at its end starts the next one', () => {
    const blocks = aggregateBlocks([
      event('2026-06-15T09:10:00.000Z'),
      event('2026-06-15T13:59:59.000Z'),
      event('2026-06-15T14:00:00.000Z'),
    ]);

    expect(spans(blocks)).toEqual([
      'claude 2026-06-15T09:00:00.000Z 2026-06-15T14:00:00.000Z 2',
      'claude 2026-06-15T14:00:00.000Z 2026-06-15T19:00:00.000Z 1',
    ]);
  });

  it('starts the next block at the hour of the first event after the previous end', () => {
    const blocks = aggregateBlocks([
      event('2026-06-15T09:10:00.000Z'),
      event('2026-06-15T16:45:00.000Z'),
    ]);

    expect(blocks.map((block) => block.start)).toEqual([
      '2026-06-15T09:00:00.000Z',
      '2026-06-15T16:00:00.000Z',
    ]);
  });

  it('keeps a block crossing midnight whole', () => {
    const blocks = aggregateBlocks([
      event('2026-06-20T22:30:00.000Z'),
      event('2026-06-21T01:40:00.000Z'),
    ]);

    expect(spans(blocks)).toEqual(['claude 2026-06-20T22:00:00.000Z 2026-06-21T03:00:00.000Z 2']);
  });

  it('chains each source on its own, ordered by start then source order', () => {
    const blocks = aggregateBlocks(
      [
        event('2026-06-15T09:10:00.000Z', { source: 'claude' }),
        event('2026-06-15T09:20:00.000Z', { source: 'codex' }),
        event('2026-06-15T12:00:00.000Z', { source: 'codex' }),
        event('2026-06-15T14:30:00.000Z', { source: 'claude' }),
      ],
      { sourceOrder: ['codex', 'claude'] },
    );

    expect(spans(blocks)).toEqual([
      'codex 2026-06-15T09:00:00.000Z 2026-06-15T14:00:00.000Z 2',
      'claude 2026-06-15T09:00:00.000Z 2026-06-15T14:00:00.000Z 1',
      'claude 2026-06-15T14:00:00.000Z 2026-06-15T19:00:00.000Z 1',
    ]);
  });

  it('merges every machine of a source into one stream, as one account limit', () => {
    const blocks = aggregateBlocks([
      event('2026-06-15T09:10:00.000Z'),
      event('2026-06-15T10:00:00.000Z', { machine: 'laptop' }),
      event('2026-06-15T13:30:00.000Z', { machine: 'desktop' }),
    ]);

    expect(spans(blocks)).toEqual(['claude 2026-06-15T09:00:00.000Z 2026-06-15T14:00:00.000Z 3']);
  });

  it('sums tokens and cost, and marks a block whose cost is incomplete', () => {
    const [block] = aggregateBlocks([
      event('2026-06-15T09:10:00.000Z', { costUsd: 0.25, tokens: 100 }),
      event('2026-06-15T09:20:00.000Z', { costUsd: 0.5, tokens: 200, model: 'other' }),
      event('2026-06-15T09:30:00.000Z', { tokens: 50 }),
    ]);

    expect(block).toMatchObject({
      inputTokens: 350,
      totalTokens: 350,
      costUsd: 0.75,
      costIncomplete: true,
      models: ['other', 'claude-sonnet-4-5'],
    });
  });

  describe('lookback before since', () => {
    const sinceMs = Date.parse('2026-06-15T00:00:00.000Z');
    const rangeStartMs = sinceMs - 7 * DAY_MS;

    it('drops blocks that end at or before since', () => {
      const blocks = aggregateBlocks(
        [
          event('2026-06-14T10:00:00.000Z'),
          event('2026-06-14T19:00:00.000Z'),
          event('2026-06-14T21:30:00.000Z'),
          event('2026-06-14T23:50:00.000Z'),
          event('2026-06-15T01:00:00.000Z'),
        ],
        { sinceMs, rangeStartMs },
      );

      // 19:00 to 00:00 ends exactly at since.
      expect(spans(blocks)).toEqual(['claude 2026-06-15T01:00:00.000Z 2026-06-15T06:00:00.000Z 1']);
    });

    it('keeps the earlier events of a block running into since', () => {
      const blocks = aggregateBlocks(
        [
          event('2026-06-14T10:00:00.000Z'),
          event('2026-06-14T22:30:00.000Z'),
          event('2026-06-14T23:50:00.000Z'),
          event('2026-06-15T01:00:00.000Z'),
        ],
        { sinceMs, rangeStartMs },
      );

      expect(spans(blocks)).toEqual(['claude 2026-06-14T22:00:00.000Z 2026-06-15T03:00:00.000Z 3']);
      expect(blocks[0]?.startUncertain).toBe(false);
    });

    it('chains from the last gap of 5 h or more before since', () => {
      const blocks = aggregateBlocks(
        [
          event('2026-06-14T02:00:00.000Z'),
          event('2026-06-14T09:30:00.000Z'),
          event('2026-06-14T13:00:00.000Z'),
          event('2026-06-14T16:30:00.000Z'),
          event('2026-06-14T20:00:00.000Z'),
          event('2026-06-14T23:30:00.000Z'),
          event('2026-06-15T02:00:00.000Z'),
        ],
        { sinceMs, rangeStartMs },
      );

      // 09:00-14:00, 16:00-21:00, then 23:00-04:00, the only block ending after since.
      expect(spans(blocks)).toEqual(['claude 2026-06-14T23:00:00.000Z 2026-06-15T04:00:00.000Z 2']);
      expect(blocks[0]?.startUncertain).toBe(false);
    });

    it('marks the start uncertain without such a gap since the range start', () => {
      // An event every 4 h from 1 h after the range start: no gap of 5 h anywhere.
      const events = Array.from({ length: 7 * 6 + 2 }, (_, index) =>
        event(new Date(rangeStartMs + HOUR_MS + index * 4 * HOUR_MS).toISOString()),
      );
      const blocks = aggregateBlocks(events, { sinceMs, rangeStartMs });

      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks.every((block) => block.startUncertain)).toBe(true);
    });

    it('is certain again after a gap of 5 h or more inside the window', () => {
      const blocks = aggregateBlocks(
        [
          event(new Date(rangeStartMs + HOUR_MS).toISOString()),
          ...Array.from({ length: 42 }, (_, index) =>
            event(new Date(rangeStartMs + 5 * HOUR_MS + index * 4 * HOUR_MS).toISOString()),
          ),
          event('2026-06-15T12:00:00.000Z'),
        ],
        { sinceMs, rangeStartMs },
      );

      expect(blocks.map((block) => block.startUncertain)).toEqual([true, false]);
    });

    it('is certain when the first event comes 5 h or more after the range start', () => {
      const [block] = aggregateBlocks([event('2026-06-15T09:10:00.000Z')], {
        sinceMs,
        rangeStartMs,
      });

      expect(block.startUncertain).toBe(false);
    });

    it('is certain over the full history', () => {
      const [block] = aggregateBlocks([event('2026-06-15T09:10:00.000Z')]);

      expect(block.startUncertain).toBe(false);
    });
  });
});

describe('active block and burn rate', () => {
  const [block] = aggregateBlocks([
    event('2026-06-21T10:15:00.000Z', { costUsd: 1, tokens: 3_000 }),
  ]) as [UsageBlock];

  it('is active from its start, inclusive, to its end, exclusive', () => {
    expect(isBlockActive(block, Date.parse('2026-06-21T09:59:59.999Z'))).toBe(false);
    expect(isBlockActive(block, Date.parse('2026-06-21T10:00:00.000Z'))).toBe(true);
    expect(isBlockActive(block, Date.parse('2026-06-21T14:59:59.999Z'))).toBe(true);
    expect(isBlockActive(block, Date.parse('2026-06-21T15:00:00.000Z'))).toBe(false);
  });

  it('divides usage by the time since the block started', () => {
    expect(computeBurnRate(block, Date.parse('2026-06-21T12:00:00.000Z'))).toEqual({
      remainingMinutes: 180,
      tokensPerHour: 1_500,
      costUsdPerHour: 0.5,
    });
  });

  it('counts at least one minute, and flags an incomplete cost', () => {
    const [incomplete] = aggregateBlocks([
      event('2026-06-21T10:00:00.000Z', { costUsd: 1, tokens: 60 }),
      event('2026-06-21T10:00:00.000Z', { tokens: 60 }),
    ]) as [UsageBlock];

    expect(computeBurnRate(incomplete, Date.parse('2026-06-21T10:00:00.000Z'))).toEqual({
      remainingMinutes: 300,
      tokensPerHour: 7_200,
      costUsdPerHour: 60,
      costIncomplete: true,
    });
  });
});

describe('top blocks', () => {
  const blocks = aggregateBlocks([
    event('2026-06-15T01:00:00.000Z', { costUsd: 1, tokens: 900 }),
    event('2026-06-15T07:00:00.000Z', { costUsd: 3, tokens: 100 }),
    event('2026-06-15T13:00:00.000Z', { costUsd: 1, tokens: 500 }),
    event('2026-06-15T19:00:00.000Z', { costUsd: 2, tokens: 900 }),
  ]);

  it('ranks by cost, ties by start', () => {
    const ranking = resolveBlockRanking(blocks);

    expect(ranking).toBe('cost');
    expect(selectTopBlocks(blocks, 3, ranking).map((block) => block.firstEventAt)).toEqual([
      '2026-06-15T07:00:00.000Z',
      '2026-06-15T19:00:00.000Z',
      '2026-06-15T01:00:00.000Z',
    ]);
  });

  it('ranks by tokens with cost hidden or when any cost is incomplete', () => {
    const withUnpriced = [
      ...blocks,
      ...aggregateBlocks([event('2026-06-16T01:00:00.000Z', { tokens: 10 })]),
    ];

    expect(resolveBlockRanking(blocks, { hideCost: true })).toBe('tokens');
    expect(resolveBlockRanking(withUnpriced)).toBe('tokens');
    expect(selectTopBlocks(withUnpriced, 2, 'tokens').map((block) => block.firstEventAt)).toEqual([
      '2026-06-15T01:00:00.000Z',
      '2026-06-15T19:00:00.000Z',
    ]);
  });
});

/** Deterministic pseudo-random numbers (mulberry32). */
function createRandom(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Bursts of events per source over `days` days, with gaps from minutes to a day. */
function randomEvents(random: () => number, startMs: number, days: number): UsageEvent[] {
  const events: UsageEvent[] = [];

  for (const source of ['claude', 'codex']) {
    let timeMs = startMs + random() * 6 * HOUR_MS;

    while (timeMs < startMs + days * DAY_MS) {
      events.push(
        event(new Date(Math.floor(timeMs / 1000) * 1000).toISOString(), {
          source,
          machine: random() < 0.3 ? 'laptop' : undefined,
          tokens: 1 + Math.floor(random() * 1_000),
          costUsd: Math.floor(random() * 100) / 100,
        }),
      );
      const longGap = random() < 0.15;
      timeMs += longGap ? (5 + random() * 19) * HOUR_MS : random() * 2 * HOUR_MS;
    }
  }

  return events;
}

function blockKey(block: UsageBlock): string {
  return JSON.stringify(block);
}

describe('block properties', () => {
  const firstDayMs = Date.parse('2026-05-01T00:00:00.000Z');

  it('leaves later blocks unchanged when since moves a day earlier', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const events = randomEvents(createRandom(seed), firstDayMs, 40);
      const sinceMs = firstDayMs + 25 * DAY_MS;
      const run = (since: number) =>
        aggregateBlocks(
          events.filter((candidate) => Date.parse(candidate.timestamp) >= since - 7 * DAY_MS),
          { sinceMs: since, rangeStartMs: since - 7 * DAY_MS },
        );
      // A block is certain once a gap of 5 h or more precedes it.
      const later = run(sinceMs).filter((block) => !block.startUncertain);
      const earlier = new Set(run(sinceMs - DAY_MS).map(blockKey));

      expect(later.length).toBeGreaterThan(0);

      for (const block of later) {
        expect(earlier.has(blockKey(block)), `seed ${String(seed)} ${block.start}`).toBe(true);
      }
    }
  });

  it('matches the full-history chain for every block that ends after since', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const events = randomEvents(createRandom(seed), firstDayMs, 40);
      const sinceMs = firstDayMs + 25 * DAY_MS;
      const full = new Set(aggregateBlocks(events).map(blockKey));
      const windowed = aggregateBlocks(
        events.filter((candidate) => Date.parse(candidate.timestamp) >= sinceMs - 7 * DAY_MS),
        { sinceMs, rangeStartMs: sinceMs - 7 * DAY_MS },
      );

      for (const block of windowed) {
        if (!block.startUncertain) {
          expect(full.has(blockKey(block)), `seed ${String(seed)} ${block.start}`).toBe(true);
        }
      }
    }
  });

  it('partitions the events in kept blocks, and totals equal their sums', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const sinceMs = firstDayMs + 10 * DAY_MS;
      const events = randomEvents(createRandom(seed), sinceMs - 7 * DAY_MS, 20);
      const blocks = aggregateBlocks(events, { sinceMs, rangeStartMs: sinceMs - 7 * DAY_MS });
      const owners = events.map((candidate) => {
        const timeMs = Date.parse(candidate.timestamp);
        return blocks.filter(
          (block) =>
            block.source === candidate.source &&
            Date.parse(block.start) <= timeMs &&
            timeMs < Date.parse(block.end),
        );
      });

      // No event lies in two blocks, and every event from since on lies in one.
      expect(owners.every((owner) => owner.length <= 1)).toBe(true);
      events.forEach((candidate, index) => {
        if (Date.parse(candidate.timestamp) >= sinceMs) {
          expect(owners[index]).toHaveLength(1);
        }
      });

      for (const block of blocks) {
        const inBlock = events.filter((_, index) => owners[index]?.[0] === block);
        expect(Date.parse(block.end) - Date.parse(block.start)).toBe(BLOCK_DURATION_MS);
        expect(block.eventCount).toBe(inBlock.length);
        expect(block.totalTokens).toBe(inBlock.reduce((sum, item) => sum + item.totalTokens, 0));
        expect(block.costUsd).toBeCloseTo(
          inBlock.reduce((sum, item) => sum + (item.costUsd ?? 0), 0),
          9,
        );
      }
    }
  });
});
