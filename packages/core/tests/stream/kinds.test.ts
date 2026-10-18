import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createMessageEvent,
  createSessionMetaEvent,
  createToolCallEvent,
  createUsageRecord,
  type MessageEvent,
  type SessionEvent,
  type ToolCallEvent,
} from '../../src/domain/session-event.js';
import { collect } from '../../src/stream/collect.js';
import { kinds } from '../../src/stream/kinds.js';
import { pipe } from '../../src/stream/pipe.js';

const base = { source: 'pi', sessionId: 's', timestamp: '2026-06-01T10:00:00.000Z' };
const events: SessionEvent[] = [
  createSessionMetaEvent({ ...base, cwd: '/repo' }),
  createMessageEvent({ ...base, role: 'user', textLength: 1 }),
  createToolCallEvent({ ...base, name: 'Bash', status: 'ok' }),
  createUsageRecord({ ...base, inputTokens: 1 }),
  createMessageEvent({ ...base, role: 'assistant', textLength: 2 }),
];

async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  yield* items;
}

describe('kinds', () => {
  it('keeps the wanted kinds in input order', async () => {
    const kept = await collect(pipe(fromArray(events), kinds('message', 'tool_call')));

    expect(kept).toEqual([events[1], events[2], events[4]]);
    expectTypeOf(kept).toEqualTypeOf<(MessageEvent | ToolCallEvent)[]>();
  });

  it('keeps nothing when no kind is wanted', async () => {
    await expect(collect(pipe(fromArray(events), kinds()))).resolves.toEqual([]);
  });
});
