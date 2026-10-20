import { describe, expect, it } from 'vitest';

import { dedupeCopiedSessions } from '../../src/dedup/copied-session.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';

function createEvent(
  sessionId: string,
  timestamp: string,
  outputTokens = 5,
  model = 'claude-sonnet-4-5',
  ids: { messageId?: string; requestId?: string } = {},
) {
  return createUsageEvent({
    source: 'claude',
    sessionId,
    timestamp,
    provider: 'anthropic',
    model,
    inputTokens: 10,
    outputTokens,
    cacheReadTokens: 100,
    ...ids,
  });
}

function createRequest(sessionId: string, messageId: string, requestId?: string) {
  return createEvent(sessionId, '2026-10-09T10:00:00.000Z', 5, 'claude-sonnet-4-5', {
    messageId,
    requestId,
  });
}

describe('dedupeCopiedSessions', () => {
  it('counts a branched session copy once, in the session that started first', () => {
    const original = [
      createEvent('original', '2026-10-09T10:00:00.000Z'),
      createEvent('original', '2026-10-09T10:05:00.000Z'),
    ];
    const branch = [
      createEvent('branch', '2026-10-09T10:05:00.000Z'),
      createEvent('branch', '2026-10-09T11:00:00.000Z'),
    ];

    expect(dedupeCopiedSessions([...branch, ...original])).toEqual([branch[1], ...original]);
  });

  it('keeps events of different sessions that only share a timestamp', () => {
    const events = [
      createEvent('first', '2026-10-09T10:00:00.000Z', 316),
      createEvent('second', '2026-10-09T10:00:00.000Z', 355),
      createEvent('third', '2026-10-09T10:00:00.000Z', 316, 'claude-haiku-4-5'),
    ];

    expect(dedupeCopiedSessions(events)).toEqual(events);
  });

  it('keeps identical events within one session and drops only the extra copies', () => {
    const original = [
      createEvent('original', '2026-10-09T09:00:00.000Z'),
      createEvent('original', '2026-10-09T10:00:00.000Z'),
      createEvent('original', '2026-10-09T10:00:00.000Z'),
    ];
    const branch = [createEvent('branch', '2026-10-09T10:00:00.000Z')];

    expect(dedupeCopiedSessions([...original, ...branch])).toEqual(original);
  });

  it('keeps requests of different sessions with the same usage but different ids', () => {
    const events = [
      createRequest('first', 'msg_1', 'req_1'),
      createRequest('second', 'msg_2', 'req_2'),
      // A retry reuses the message id under a fresh request id.
      createRequest('third', 'msg_1', 'req_3'),
    ];

    expect(dedupeCopiedSessions(events)).toEqual(events);
  });

  it('counts a copy that keeps its ids once', () => {
    const original = [
      createEvent('original', '2026-10-09T09:00:00.000Z'),
      createRequest('original', 'msg_1', 'req_1'),
    ];
    const continued = [createRequest('continued', 'msg_1', 'req_1')];

    expect(dedupeCopiedSessions([...continued, ...original])).toEqual(original);
  });

  it('counts an event stored without ids once with a copy that has them', () => {
    // The original's file is gone, and history serves it as stored before events had ids.
    const original = [
      createEvent('original', '2026-10-09T09:00:00.000Z'),
      createEvent('original', '2026-10-09T10:00:00.000Z'),
    ];
    const continued = [createRequest('continued', 'msg_1', 'req_1')];
    const distinct = createRequest('other', 'msg_2', 'req_2');

    expect(dedupeCopiedSessions([...original, ...continued, distinct])).toEqual([
      ...original,
      distinct,
    ]);
  });
});
