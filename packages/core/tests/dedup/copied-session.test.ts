import { describe, expect, it } from 'vitest';

import { dedupeCopiedSessions } from '../../src/dedup/copied-session.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';

function createEvent(
  sessionId: string,
  timestamp: string,
  outputTokens = 5,
  model = 'claude-sonnet-4-5',
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
});
