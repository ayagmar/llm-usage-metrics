import { describe, expect, it } from 'vitest';

import { computeEventContentHash } from '../../src/dedup/content-hash.js';
import {
  addHashCount,
  dedupeRepeatedAcrossFiles,
  takeUncountedEvents,
} from '../../src/dedup/repeated-across-files.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';

function createEvent(sessionId: string, timestamp: string, outputTokens = 5) {
  return createUsageEvent({
    source: 'pi',
    sessionId,
    timestamp,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 10,
    outputTokens,
  });
}

describe('addHashCount', () => {
  it('adds a positive count and ignores a count of zero or less', () => {
    const counts = new Map([['a', 1]]);

    addHashCount(counts, 'a', 2);
    addHashCount(counts, 'b', 0);
    addHashCount(counts, 'c', -1);

    expect([...counts]).toEqual([['a', 3]]);
  });
});

describe('takeUncountedEvents', () => {
  it('drops as many copies of an event as are already counted and counts the rest', () => {
    const event = createEvent('parent', '2026-10-09T10:00:00.000Z');
    const other = createEvent('parent', '2026-10-09T10:05:00.000Z');
    const counted = new Map([[computeEventContentHash(event), 1]]);
    const copy = { ...event };

    expect(takeUncountedEvents([event, copy, other], counted)).toEqual([copy, other]);
    expect(counted).toEqual(
      new Map([
        [computeEventContentHash(event), 2],
        [computeEventContentHash(other), 1],
      ]),
    );
  });
});

describe('dedupeRepeatedAcrossFiles', () => {
  it('counts an event that a fork repeats from its parent once, from the first file', () => {
    const parent = [
      createEvent('parent', '2026-10-09T10:00:00.000Z'),
      createEvent('parent', '2026-10-09T10:05:00.000Z'),
    ];
    const fork = [{ ...parent[0] }, createEvent('fork', '2026-10-09T11:00:00.000Z')];

    const result = dedupeRepeatedAcrossFiles([parent, fork]);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(parent[0]);
    expect(result[1]).toBe(parent[1]);
    expect(result[2]).toBe(fork[1]);
  });

  it('keeps every event of files whose sessions no other file holds', () => {
    const first = [createEvent('first', '2026-10-09T10:00:00.000Z')];
    const second = [createEvent('second', '2026-10-09T10:00:00.000Z')];
    const repeatedWithinFile = [first[0], { ...first[0] }];

    expect(dedupeRepeatedAcrossFiles([repeatedWithinFile, second])).toEqual([
      ...repeatedWithinFile,
      ...second,
    ]);
  });

  it('returns the caller event type with its extra fields', () => {
    const event = { ...createEvent('shared', '2026-10-09T10:00:00.000Z'), machine: 'laptop' };
    const result = dedupeRepeatedAcrossFiles([[event], [{ ...event, machine: 'desktop' }]]);

    expect(result.map((kept) => kept.machine)).toEqual(['laptop']);
  });
});
