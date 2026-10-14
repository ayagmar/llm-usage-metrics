import { describe, expect, it } from 'vitest';

import { dedupeRepeatedAcrossFiles } from '../../src/dedup/repeated-across-files.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
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

describe('dedupeRepeatedAcrossFiles properties', () => {
  type EventFile = UsageEvent[];

  function linesOf(events: readonly UsageEvent[]): string[] {
    return events.map((event) => JSON.stringify(event));
  }

  function dedupedLines(files: readonly EventFile[]): string[] {
    return linesOf(dedupeRepeatedAcrossFiles(files));
  }

  // The content hash covers repoRoot, costMode and costUsd, so they follow the session
  // and the shape: a repeated event is identical in every file that holds it.
  function createFileEvent(sessionIndex: number, shape: EventShape): UsageEvent {
    return createUsageEvent({
      source: 'pi',
      sessionId: `session-${sessionIndex}`,
      timestamp: shape.timestamp,
      provider: 'anthropic',
      model: shape.model,
      ...shape.usage,
      repoRoot: `/repos/project-${sessionIndex}`,
      costUsd: (shape.usage.inputTokens + shape.usage.outputTokens) / 1000,
      costMode: 'explicit',
    });
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
