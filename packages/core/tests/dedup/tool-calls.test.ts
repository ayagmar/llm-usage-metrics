import { describe, expect, it } from 'vitest';

import { createToolCallEvent, dedupeToolCalls, type ToolCallEvent } from '@ayagmar/agent-sessions';

function call(
  status: ToolCallEvent['status'],
  options: { source?: string; sessionId?: string; toolCallId?: string } = {},
): ToolCallEvent {
  return createToolCallEvent({
    source: options.source ?? 'claude',
    sessionId: options.sessionId ?? 's1',
    timestamp: '2026-06-20T10:00:00.000Z',
    name: 'Bash',
    status,
    toolCallId: options.toolCallId,
  });
}

describe('dedupeToolCalls', () => {
  it('counts a call another session copied once, taking the status of the copy with a result', () => {
    const calls = dedupeToolCalls([
      call('unknown', { sessionId: 's1', toolCallId: 't1' }),
      call('error', { sessionId: 's2', toolCallId: 't1' }),
      call('ok', { sessionId: 's2', toolCallId: 't1' }),
    ]);

    expect(calls).toEqual([expect.objectContaining({ sessionId: 's1', status: 'error' })]);
  });

  it('keeps calls without an id, and the same id from two sources', () => {
    const calls = dedupeToolCalls([
      call('ok'),
      call('ok'),
      call('ok', { toolCallId: 't1' }),
      call('ok', { source: 'codex', toolCallId: 't1' }),
    ]);

    expect(calls).toHaveLength(4);
  });
});
