import { describe, expect, it } from 'vitest';

import { copiedSessions, dedupeCopiedSessions } from '../../src/dedup/copied-session.js';
import {
  dedupeRepeatedAcrossFiles,
  repeatedAcrossFiles,
} from '../../src/dedup/repeated-across-files.js';
import {
  createMessageEvent,
  createToolCallEvent,
  createUsageRecord,
  isUsageRecord,
  type SessionEvent,
} from '../../src/domain/session-event.js';
import { collect } from '../../src/stream/collect.js';
import { pipe } from '../../src/stream/pipe.js';

function usage(sessionId: string, timestamp: string, outputTokens = 5) {
  return createUsageRecord({
    source: 'pi',
    sessionId,
    timestamp,
    model: 'claude-sonnet-4-5',
    inputTokens: 10,
    outputTokens,
  });
}

function message(sessionId: string, timestamp: string) {
  return createMessageEvent({ source: 'pi', sessionId, timestamp, role: 'user', textLength: 3 });
}

async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  yield* items;
}

describe('repeated-across-files dedup over session events', () => {
  // A fork file repeats its parent's usage and message, then adds its own.
  const parentFile: SessionEvent[] = [
    message('parent', '2026-10-09T10:00:00.000Z'),
    usage('parent', '2026-10-09T10:00:01.000Z'),
  ];
  const forkFile: SessionEvent[] = [
    message('parent', '2026-10-09T10:00:00.000Z'),
    usage('parent', '2026-10-09T10:00:01.000Z'),
    createToolCallEvent({
      source: 'pi',
      sessionId: 'fork',
      timestamp: '2026-10-09T11:00:00.000Z',
      name: 'bash',
      status: 'ok',
    }),
    usage('fork', '2026-10-09T11:00:01.000Z'),
  ];
  const expected = [...parentFile, forkFile[0], forkFile[2], forkFile[3]];

  it('dedupes usage only and keeps every other kind where it was', () => {
    expect(dedupeRepeatedAcrossFiles([parentFile, forkFile])).toEqual(expected);
  });

  it('gives the stage the same result', async () => {
    await expect(
      collect(pipe(fromArray([parentFile, forkFile]), repeatedAcrossFiles())),
    ).resolves.toEqual(expected);
  });

  it('dedupes usage records as it dedupes the usage alone', () => {
    const usageOnly = [parentFile, forkFile].map((events) => events.filter(isUsageRecord));

    expect(dedupeRepeatedAcrossFiles([parentFile, forkFile]).filter(isUsageRecord)).toEqual(
      dedupeRepeatedAcrossFiles(usageOnly),
    );
  });

  it('does not share a session through other kinds', () => {
    // Only a message ties session "s" to the second file; its usage is not a repeat.
    const first: SessionEvent[] = [usage('s', '2026-10-09T10:00:00.000Z')];
    const second: SessionEvent[] = [message('s', '2026-10-09T09:00:00.000Z')];

    expect(dedupeRepeatedAcrossFiles([first, second])).toEqual([...first, ...second]);
  });
});

describe('copied-session dedup over session events', () => {
  const original = [
    usage('original', '2026-10-09T10:00:00.000Z'),
    usage('original', '2026-10-09T10:05:00.000Z'),
  ];
  // The continuation copies the 10:05 event; its own message is older than every
  // usage event, which must not make it the session that keeps the copy.
  const continuationMessage = message('continued', '2026-10-09T09:00:00.000Z');
  const continuation: SessionEvent[] = [
    continuationMessage,
    usage('continued', '2026-10-09T10:05:00.000Z'),
    usage('continued', '2026-10-09T10:30:00.000Z', 9),
  ];

  it('dedupes usage only, by usage session starts, keeping other kinds in place', () => {
    expect(dedupeCopiedSessions([...original, ...continuation])).toEqual([
      ...original,
      continuationMessage,
      continuation[2],
    ]);
  });

  it('gives the stage the same result', async () => {
    await expect(
      collect(pipe(fromArray([...continuation, ...original]), copiedSessions())),
    ).resolves.toEqual([continuationMessage, continuation[2], ...original]);
  });

  it('passes everything through when nothing is copied', () => {
    const events = [continuationMessage, ...original];

    expect(dedupeCopiedSessions(events)).toEqual(events);
  });
});
