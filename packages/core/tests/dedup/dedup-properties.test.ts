import { describe, expect, it } from 'vitest';

import { dedupeCopiedSessions } from '../../src/dedup/copied-session.js';
import { dedupeRepeatedAcrossFiles } from '../../src/dedup/repeated-across-files.js';
import { createUsageEvent, type CostMode, type UsageEvent } from '../../src/domain/usage-event.js';
import { mulberry32, pick, randomInt, shuffle, type Random } from '../helpers/seeded-random.js';

const ITERATIONS = 200;
/**
 * The fewest iterations of a property whose generated data must hold copies (the output is
 * shorter than the input); without them the property could pass on copy-free data.
 */
const MIN_ITERATIONS_WITH_COPIES = 50;

// A small alphabet, so generated sessions often hold the same timestamp, model and usage.
const TIMESTAMPS = [
  '2026-06-01T10:00:00.000Z',
  '2026-06-01T10:05:00.000Z',
  '2026-06-02T08:00:00.000Z',
  '2026-06-03T21:30:00.000Z',
];
const MODELS = ['claude-sonnet-4-5', 'claude-opus-4-1'];
const USAGES = [
  { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  { inputTokens: 100, outputTokens: 20, cacheReadTokens: 400, cacheWriteTokens: 0 },
  { inputTokens: 7, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 50 },
];
const PROVIDERS = ['anthropic', 'openai'];

type EventShape = {
  timestamp: string;
  model: string;
  usage: (typeof USAGES)[number];
};

const SHAPES: EventShape[] = TIMESTAMPS.flatMap((timestamp) =>
  MODELS.flatMap((model) => USAGES.map((usage) => ({ timestamp, model, usage }))),
);

function sampleDistinct<T>(random: Random, items: readonly T[], count: number): T[] {
  return shuffle(items, random).slice(0, count);
}

function failureMessage(seed: number, iteration: number): string {
  return `seed ${seed}, iteration ${iteration}`;
}

function toSortedMultiset(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('dedupeCopiedSessions properties', () => {
  type SessionSettings = {
    sessionId: string;
    provider: string;
    repoRoot: string;
    costUsd: number;
  };

  // Written out here rather than imported so the test states which fields make two
  // events copies of each other.
  function copyIdentity(event: UsageEvent): string {
    return [
      event.timestamp,
      event.provider ?? '',
      event.model ?? '',
      event.inputTokens,
      event.outputTokens,
      event.reasoningTokens,
      event.cacheReadTokens,
      event.cacheWriteTokens,
      event.cacheWrite1hTokens,
      event.totalTokens,
    ].join('|');
  }

  function copyKey(event: UsageEvent): string {
    return `${event.sessionId}|${copyIdentity(event)}`;
  }

  function keysOf(events: readonly UsageEvent[]): string[] {
    return toSortedMultiset(events.map(copyKey));
  }

  function createSessionEvent(settings: SessionSettings, shape: EventShape): UsageEvent {
    return createUsageEvent({
      source: 'claude',
      sessionId: settings.sessionId,
      timestamp: shape.timestamp,
      provider: settings.provider,
      model: shape.model,
      ...shape.usage,
      repoRoot: settings.repoRoot,
      costUsd: settings.costUsd,
    });
  }

  function createSessionSettings(random: Random, index: number): SessionSettings {
    return {
      sessionId: `session-${index}`,
      provider: pick(random, PROVIDERS),
      repoRoot: `/repos/project-${index}`,
      costUsd: (index + 1) / 100,
    };
  }

  // Sessions draw distinct shapes from the shared alphabet, so copies across sessions are
  // common while one session never holds the same identity twice.
  function generateSessions(random: Random): UsageEvent[] {
    const sessionCount = 2 + randomInt(random, 4);
    const events = Array.from({ length: sessionCount }, (_, index) => {
      const settings = createSessionSettings(random, index);
      const shapes = sampleDistinct(random, SHAPES, 1 + randomInt(random, 6));
      return shapes.map((shape) => createSessionEvent(settings, shape));
    }).flat();

    return shuffle(events, random);
  }

  // Every session draws from its own slice of the alphabet, so no event is a copy.
  function generateSessionsWithoutCopies(random: Random): UsageEvent[] {
    const sessionCount = 1 + randomInt(random, 4);
    const unclaimed = shuffle(SHAPES, random);
    const events = Array.from({ length: sessionCount }, (_, index) => {
      const settings = createSessionSettings(random, index);
      const shapes = unclaimed.splice(0, 1 + randomInt(random, 5));
      return shapes.map((shape) => createSessionEvent(settings, shape));
    }).flat();

    return shuffle(events, random);
  }

  // Idempotent only because no generated session holds two events with the same
  // identity. In general it is not: a session holding an identity twice keeps its second
  // copy on the first pass and loses it on the next (KI-9; see the max-count example below).
  it('is idempotent: counting copies once a second time removes nothing more', () => {
    const seed = 0x5eed_0001;
    const random = mulberry32(seed);

    let withCopies = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const events = generateSessions(random);
      const once = dedupeCopiedSessions(events);
      const twice = dedupeCopiedSessions(once);
      withCopies += once.length < events.length ? 1 : 0;

      expect(keysOf(twice), failureMessage(seed, iteration)).toEqual(keysOf(once));
    }

    expect(withCopies, `seed ${seed}`).toBeGreaterThanOrEqual(MIN_ITERATIONS_WITH_COPIES);
  });

  it('keeps the same events whatever order the input arrives in', () => {
    const seed = 0x5eed_0002;
    const random = mulberry32(seed);

    let withCopies = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const events = generateSessions(random);
      const reordered = shuffle(events, random);
      const original = dedupeCopiedSessions(events);
      withCopies += original.length < events.length ? 1 : 0;

      expect(keysOf(dedupeCopiedSessions(reordered)), failureMessage(seed, iteration)).toEqual(
        keysOf(original),
      );
    }

    expect(withCopies, `seed ${seed}`).toBeGreaterThanOrEqual(MIN_ITERATIONS_WITH_COPIES);
  });

  it('returns input events in input order, keeping one of each copied event', () => {
    const seed = 0x5eed_0003;
    const random = mulberry32(seed);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const events = generateSessions(random);
      const result = dedupeCopiedSessions(events);
      const inputPositions = result.map((event) => events.indexOf(event));
      const resultIdentities = result.map(copyIdentity);
      const inputIdentities = events.map(copyIdentity);

      expect(toSortedMultiset(resultIdentities), failureMessage(seed, iteration)).toEqual(
        toSortedMultiset([...new Set(inputIdentities)]),
      );

      expect(inputPositions, failureMessage(seed, iteration)).not.toContain(-1);
      expect(inputPositions, failureMessage(seed, iteration)).toEqual(
        [...inputPositions].sort((left, right) => left - right),
      );
      expect(new Set(inputPositions).size, failureMessage(seed, iteration)).toBe(
        inputPositions.length,
      );
    }
  });

  it('leaves a dataset without copies unchanged', () => {
    const seed = 0x5eed_0004;
    const random = mulberry32(seed);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const events = generateSessionsWithoutCopies(random);

      expect(dedupeCopiedSessions(events), failureMessage(seed, iteration)).toEqual(events);
    }
  });

  it('ignores a later session that copies an existing session verbatim', () => {
    const seed = 0x5eed_0005;
    const random = mulberry32(seed);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const events = generateSessions(random);
      const copiedSessionId = pick(random, events).sessionId;
      // Verbatim timestamps give the copy the same start as the session it copies, so it
      // starts later through the tie-break: "session-copy" sorts after every "session-<n>".
      const copy = events
        .filter((event) => event.sessionId === copiedSessionId)
        .map((event) => ({ ...event, sessionId: 'session-copy' }));

      expect(
        keysOf(dedupeCopiedSessions([...events, ...copy])),
        failureMessage(seed, iteration),
      ).toEqual(keysOf(dedupeCopiedSessions(events)));
    }
  });

  it('counts every identical event within a session beyond those an older session holds', () => {
    const shape = SHAPES[0];
    const older = createSessionSettings(mulberry32(1), 0);
    const newer = { ...older, sessionId: 'session-1' };
    const olderStart = createSessionEvent(older, {
      ...shape,
      timestamp: '2026-05-31T00:00:00.000Z',
    });
    const events = [
      olderStart,
      createSessionEvent(older, shape),
      createSessionEvent(newer, shape),
      createSessionEvent(newer, shape),
    ];

    // The newer session's first copy is the older session's event; its second is its own.
    // A second pass would then drop that one too: the max-count rule is why the
    // generated sessions above never repeat an identity within a session.
    const result = dedupeCopiedSessions(events);

    // By reference: events[2] and events[3] are deep-equal, so toEqual could not tell
    // which of them was kept.
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(olderStart);
    expect(result[1]).toBe(events[1]);
    expect(result[2]).toBe(events[3]);
  });
});

describe('dedupeCopiedSessions with events stored before they had ids', () => {
  const timestamp = '2026-06-01T10:00:00.000Z';

  // A request of `session`; `legacy` drops its ids, as a store or export from before
  // events carried them does.
  function request(session: number, index: number, legacy: boolean): UsageEvent {
    return createUsageEvent({
      source: 'claude',
      sessionId: `session-${session}`,
      timestamp,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 5,
      ...(legacy ? {} : { messageId: `msg_${index}`, requestId: `req_${index}` }),
    });
  }

  it('never counts more requests than the sessions hold, and all of them when that is knowable', () => {
    const seed = 0x1d5;
    const random = mulberry32(seed);
    let knowable = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      // Distinct requests with the same timestamp and usage; each session holds some of
      // them (its own or copies), and any of its events may have lost its ids.
      const requestCount = 1 + randomInt(random, 4);
      const requests = Array.from({ length: requestCount }, (_, index) => index + 1);
      const sessionCount = 2 + randomInt(random, 3);
      const held = Array.from({ length: sessionCount }, () =>
        sampleDistinct(random, requests, 1 + randomInt(random, requestCount)),
      );
      const events = held.flatMap((indexes, session) =>
        indexes.map((index) => request(session, index, randomInt(random, 2) === 0)),
      );
      const heldRequests = new Set(held.flat());
      const identified = new Set(
        events.flatMap((event) => (event.messageId === undefined ? [] : [event.messageId])),
      );
      const counted = dedupeCopiedSessions(events).length;
      const message = failureMessage(seed, iteration);

      expect(counted, message).toBeLessThanOrEqual(heldRequests.size);

      // Every request kept its ids somewhere, or one session holds them all.
      if (
        identified.size === heldRequests.size ||
        held.some((indexes) => indexes.length === heldRequests.size)
      ) {
        knowable += 1;
        expect(counted, message).toBe(heldRequests.size);
      }
    }

    expect(knowable).toBeGreaterThanOrEqual(MIN_ITERATIONS_WITH_COPIES);
  });
});

describe('dedupeRepeatedAcrossFiles properties', () => {
  type HashedEvent = UsageEvent & { costMode: CostMode };
  type EventFile = HashedEvent[];

  function linesOf(events: readonly UsageEvent[]): string[] {
    return events.map((event) => JSON.stringify(event));
  }

  function dedupedLines(files: readonly EventFile[]): string[] {
    return linesOf(dedupeRepeatedAcrossFiles(files));
  }

  // The content hash covers repoRoot, costMode and costUsd, so they follow the session
  // and the shape: a repeated event is identical in every file that holds it.
  function createFileEvent(sessionIndex: number, shape: EventShape): HashedEvent {
    return {
      ...createUsageEvent({
        source: 'pi',
        sessionId: `session-${sessionIndex}`,
        timestamp: shape.timestamp,
        provider: 'anthropic',
        model: shape.model,
        ...shape.usage,
        repoRoot: `/repos/project-${sessionIndex}`,
        costUsd: (shape.usage.inputTokens + shape.usage.outputTokens) / 1000,
      }),
      costMode: 'explicit',
    };
  }

  // Each file holds a few sessions' events, drawn without repeats within the file; files
  // sharing a session often repeat each other's events.
  function generateFiles(random: Random): EventFile[] {
    const sessionCount = 1 + randomInt(random, 3);
    const fileCount = 2 + randomInt(random, 4);

    return Array.from({ length: fileCount }, () => {
      const sessions = sampleDistinct(
        random,
        Array.from({ length: sessionCount }, (_, index) => index),
        1 + randomInt(random, 2),
      );

      return sessions.flatMap((sessionIndex) =>
        sampleDistinct(random, SHAPES, 1 + randomInt(random, 5)).map((shape) =>
          createFileEvent(sessionIndex, shape),
        ),
      );
    });
  }

  // Every file holds its own session, so no file repeats another's events.
  function generateFilesWithoutRepeats(random: Random): EventFile[] {
    const fileCount = 1 + randomInt(random, 4);

    return Array.from({ length: fileCount }, (_, fileIndex) =>
      sampleDistinct(random, SHAPES, 1 + randomInt(random, 5)).map((shape) =>
        createFileEvent(fileIndex, shape),
      ),
    );
  }

  function shuffleFiles(files: readonly EventFile[], random: Random): EventFile[] {
    return shuffle(files, random).map((events) => shuffle(events, random));
  }

  // Puts the kept events back into the files they came from: each event goes to the
  // first file, in input order, that holds it and has not been given it yet.
  function regroupIntoFiles(files: readonly EventFile[], kept: readonly UsageEvent[]) {
    const remaining = new Map<string, number>();

    for (const line of linesOf(kept)) {
      remaining.set(line, (remaining.get(line) ?? 0) + 1);
    }

    return files.map((events) =>
      events.filter((event) => {
        const line = JSON.stringify(event);
        const count = remaining.get(line) ?? 0;

        if (count === 0) {
          return false;
        }

        remaining.set(line, count - 1);
        return true;
      }),
    );
  }

  it('is idempotent: deduplicating the kept events again keeps them all', () => {
    const seed = 0x5eed_0011;
    const random = mulberry32(seed);

    let withRepeats = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const files = generateFiles(random);
      const once = dedupeRepeatedAcrossFiles(files);
      const twice = dedupeRepeatedAcrossFiles(regroupIntoFiles(files, once));
      withRepeats += once.length < files.flat().length ? 1 : 0;

      expect(toSortedMultiset(linesOf(twice)), failureMessage(seed, iteration)).toEqual(
        toSortedMultiset(linesOf(once)),
      );
    }

    expect(withRepeats, `seed ${seed}`).toBeGreaterThanOrEqual(MIN_ITERATIONS_WITH_COPIES);
  });

  it('keeps the same events whatever the file order and the event order within files', () => {
    const seed = 0x5eed_0012;
    const random = mulberry32(seed);

    let withRepeats = 0;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const files = generateFiles(random);
      const original = dedupedLines(files);
      const reordered = dedupedLines(shuffleFiles(files, random));
      withRepeats += original.length < files.flat().length ? 1 : 0;

      expect(toSortedMultiset(reordered), failureMessage(seed, iteration)).toEqual(
        toSortedMultiset(original),
      );
    }

    expect(withRepeats, `seed ${seed}`).toBeGreaterThanOrEqual(MIN_ITERATIONS_WITH_COPIES);
  });

  it('keeps each event the files hold exactly once', () => {
    const seed = 0x5eed_0013;
    const random = mulberry32(seed);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const files = generateFiles(random);

      expect(toSortedMultiset(dedupedLines(files)), failureMessage(seed, iteration)).toEqual(
        toSortedMultiset([...new Set(linesOf(files.flat()))]),
      );
    }
  });

  it('keeps the same events when a file is duplicated', () => {
    const seed = 0x5eed_0015;
    const random = mulberry32(seed);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const files = generateFiles(random);
      const duplicate = pick(random, files).map((event) => ({ ...event }));

      expect(
        toSortedMultiset(dedupedLines([...files, duplicate])),
        failureMessage(seed, iteration),
      ).toEqual(toSortedMultiset(dedupedLines(files)));
    }
  });

  it('keeps every event when no file repeats another', () => {
    const seed = 0x5eed_0014;
    const random = mulberry32(seed);

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const files = generateFilesWithoutRepeats(random);

      expect(dedupeRepeatedAcrossFiles(files), failureMessage(seed, iteration)).toEqual(
        files.flat(),
      );
    }
  });
});
