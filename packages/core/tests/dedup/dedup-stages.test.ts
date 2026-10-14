import { describe, expect, it } from 'vitest';

import { computeEventContentHash } from '../../src/dedup/content-hash.js';
import { copiedSessions, dedupeCopiedSessions } from '../../src/dedup/copied-session.js';
import {
  dedupeRepeatedAcrossFiles,
  repeatedAcrossFiles,
} from '../../src/dedup/repeated-across-files.js';
import { createUsageEvent, type CostMode, type UsageEvent } from '../../src/domain/usage-event.js';
import { collect } from '../../src/stream/collect.js';
import { mulberry32, pick, randomInt, shuffle, type Random } from '../helpers/seeded-random.js';

const ITERATIONS = 200;
/** The fewest iterations whose generated data must show a case, so no property passes vacuously. */
const MIN_ITERATIONS_WITH_CASE = 50;

// A small alphabet, so generated sessions often hold the same timestamp, model and usage.
const TIMESTAMPS = [
  '2026-06-01T10:00:00.000Z',
  '2026-06-01T10:05:00.000Z',
  '2026-06-02T08:00:00.000Z',
  '2026-06-03T21:30:00.000Z',
];
const MODELS = ['claude-sonnet-4-5', 'claude-opus-4-1'];
const USAGES = [
  { inputTokens: 10, outputTokens: 5 },
  { inputTokens: 100, outputTokens: 20, cacheReadTokens: 400 },
  { inputTokens: 7, outputTokens: 300, cacheWriteTokens: 50 },
];
const COSTS = [undefined, 0.25];

type Shape = {
  timestamp: string;
  model: string;
  usage: (typeof USAGES)[number];
  costUsd: number | undefined;
};

const SHAPES: Shape[] = TIMESTAMPS.flatMap((timestamp) =>
  MODELS.flatMap((model) =>
    USAGES.flatMap((usage) => COSTS.map((costUsd) => ({ timestamp, model, usage, costUsd }))),
  ),
);

type ModedEvent = UsageEvent & { costMode?: CostMode };

function failureMessage(seed: number, iteration: number): string {
  return `seed ${seed}, iteration ${iteration}`;
}

// A fresh object per occurrence, so the output can be traced back to input positions.
// Half the occurrences carry the mode the CLI would derive and half none, as adapter
// output does (KI-12).
function createEvent(random: Random, sessionId: string, shape: Shape): ModedEvent {
  const event = createUsageEvent({
    source: 'pi',
    sessionId,
    timestamp: shape.timestamp,
    provider: 'anthropic',
    model: shape.model,
    ...shape.usage,
    costUsd: shape.costUsd,
  });

  if (random() < 0.5) {
    return event;
  }

  return { ...event, costMode: shape.costUsd === undefined ? 'estimated' : 'explicit' };
}

// Yields each item, sometimes after a macrotask, so the consumer meets both settled and
// pending pulls.
async function* fromItems<T>(items: readonly T[], random: Random): AsyncGenerator<T> {
  for (const item of items) {
    if (random() < 0.3) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    yield item;
  }
}

function positionsIn<T>(input: readonly T[], output: readonly T[]): number[] {
  return output.map((item) => input.indexOf(item));
}

describe('repeatedAcrossFiles', () => {
  type SessionPool = { sessionId: string; shapes: Shape[] };

  // A few sessions, each with its own events; every file holds a random subset of a few
  // sessions' events, sometimes the same event twice, and sometimes nothing.
  function generateFiles(random: Random): ModedEvent[][] {
    const sessions: SessionPool[] = Array.from(
      { length: 1 + randomInt(random, 4) },
      (_, index) => ({
        sessionId: `session-${index}`,
        shapes: shuffle(SHAPES, random).slice(0, 1 + randomInt(random, 5)),
      }),
    );

    return Array.from({ length: 1 + randomInt(random, 7) }, () => {
      if (random() < 0.1) {
        return [];
      }

      const fileSessions = shuffle(sessions, random).slice(0, 1 + randomInt(random, 2));
      const events = fileSessions.flatMap((session) =>
        session.shapes
          .filter(() => random() < 0.7)
          .flatMap((shape) => {
            const copies = random() < 0.15 ? 2 : 1;
            return Array.from({ length: copies }, () =>
              createEvent(random, session.sessionId, shape),
            );
          }),
      );

      return shuffle(events, random);
    });
  }

  function recursInNonAdjacentFile(files: readonly ModedEvent[][]): boolean {
    const filesBySession = new Map<string, number[]>();

    files.forEach((events, fileIndex) => {
      for (const sessionId of new Set(events.map((event) => event.sessionId))) {
        filesBySession.set(sessionId, [...(filesBySession.get(sessionId) ?? []), fileIndex]);
      }
    });

    return [...filesBySession.values()].some((indexes) =>
      indexes.some((index, position) => position > 0 && index - indexes[position - 1] > 1),
    );
  }

  function repeatsWithinFile(files: readonly ModedEvent[][]): boolean {
    return files.some((events) => {
      const hashes = events.map((event) => computeEventContentHash(event));
      return new Set(hashes).size < hashes.length;
    });
  }

  it('keeps the events dedupeRepeatedAcrossFiles keeps, in the same order', async () => {
    const seed = 0x5eed_0601;
    const random = mulberry32(seed);
    let nonAdjacent = 0;
    let withinFile = 0;
    let withRepeats = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const files = generateFiles(random);
      const input = files.flat();
      const expected = dedupeRepeatedAcrossFiles(files);
      const actual = await collect(repeatedAcrossFiles<ModedEvent>()(fromItems(files, random)));

      expect(positionsIn(input, actual), failureMessage(seed, iteration)).toEqual(
        positionsIn(input, expected),
      );

      nonAdjacent += recursInNonAdjacentFile(files) ? 1 : 0;
      withinFile += repeatsWithinFile(files) ? 1 : 0;
      withRepeats += expected.length < input.length ? 1 : 0;
    }

    expect(nonAdjacent).toBeGreaterThanOrEqual(MIN_ITERATIONS_WITH_CASE);
    expect(withinFile).toBeGreaterThanOrEqual(MIN_ITERATIONS_WITH_CASE);
    expect(withRepeats).toBeGreaterThanOrEqual(MIN_ITERATIONS_WITH_CASE);
  });

  it('keeps the same events whether or not they carry the cost mode the CLI derives', () => {
    const seed = 0x5eed_0602;
    const random = mulberry32(seed);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const files = generateFiles(random);
      const input = files.flat();
      const withModes = files.map((events) =>
        events.map((event) => ({
          ...event,
          costMode: event.costUsd === undefined ? ('estimated' as const) : ('explicit' as const),
        })),
      );

      expect(
        positionsIn(input, dedupeRepeatedAcrossFiles(files)),
        failureMessage(seed, iteration),
      ).toEqual(positionsIn(withModes.flat(), dedupeRepeatedAcrossFiles(withModes)));
    }
  });

  it("yields a file's kept events before pulling the next file and closes the source on return", async () => {
    let pulledFiles = 0;
    let sourceClosed = false;

    async function* source(): AsyncGenerator<ModedEvent[]> {
      try {
        for (let index = 0; index < 3; index += 1) {
          pulledFiles += 1;
          yield [
            createUsageEvent({
              source: 'pi',
              sessionId: `session-${index}`,
              timestamp: TIMESTAMPS[0],
              inputTokens: 1,
              outputTokens: 1,
            }),
          ];
        }
      } finally {
        sourceClosed = true;
      }
    }

    for await (const event of repeatedAcrossFiles<ModedEvent>()(source())) {
      expect(event.sessionId).toBe('session-0');
      expect(pulledFiles).toBe(1);
      break;
    }

    expect(sourceClosed).toBe(true);
  });
});

describe('copiedSessions', () => {
  // Sessions draw shapes from the shared alphabet, so copies across sessions are common,
  // and sometimes hold one shape twice.
  function generateEvents(random: Random): ModedEvent[] {
    const events = Array.from({ length: 2 + randomInt(random, 4) }, (_, index) => {
      const shapes = shuffle(SHAPES, random).slice(0, 1 + randomInt(random, 6));
      const withRepeat = random() < 0.2 ? [...shapes, pick(random, shapes)] : shapes;
      return withRepeat.map((shape) => createEvent(random, `session-${index}`, shape));
    }).flat();

    return shuffle(events, random);
  }

  it('keeps the events dedupeCopiedSessions keeps, in the same order', async () => {
    const seed = 0x5eed_0603;
    const random = mulberry32(seed);
    let withCopies = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const events = generateEvents(random);
      const expected = dedupeCopiedSessions(events);
      const actual = await collect(copiedSessions<ModedEvent>()(fromItems(events, random)));

      expect(positionsIn(events, actual), failureMessage(seed, iteration)).toEqual(
        positionsIn(events, expected),
      );

      withCopies += expected.length < events.length ? 1 : 0;
    }

    expect(withCopies).toBeGreaterThanOrEqual(MIN_ITERATIONS_WITH_CASE);
  });
});
