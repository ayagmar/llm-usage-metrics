import { describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import { createMessageEvent, createToolCallEvent } from '@ayagmar/agent-sessions';
import { buildSessionTimeline } from '../../src/session/session-timeline.js';

function request(timestamp: string, costUsd: number | undefined) {
  return createUsageEvent({
    source: 'claude',
    sessionId: 'session-1',
    timestamp,
    model: 'Claude-Sonnet-4-5',
    inputTokens: 10,
    outputTokens: 5,
    costUsd,
  });
}

function toolCall(timestamp: string, name: string) {
  return createToolCallEvent({
    source: 'claude',
    sessionId: 'session-1',
    timestamp,
    name,
    status: 'ok',
  });
}

function userMessage(timestamp: string) {
  return createMessageEvent({
    source: 'claude',
    sessionId: 'session-1',
    timestamp,
    role: 'user',
    textLength: 12,
  });
}

describe('buildSessionTimeline', () => {
  it('sums the running cost in request time order, whatever order the events came in', () => {
    const rows = buildSessionTimeline(
      [request('2026-06-20T12:05:00.000Z', 0.25), request('2026-06-20T12:00:00.000Z', 0.5)],
      [],
    );

    expect(rows.map((row) => row.kind === 'usage' && row.runningCostUsd)).toEqual([0.5, 0.75]);
  });

  it('marks the running cost incomplete from the first unpriced request on', () => {
    const rows = buildSessionTimeline(
      [
        request('2026-06-20T12:00:00.000Z', 0.5),
        request('2026-06-20T12:01:00.000Z', undefined),
        request('2026-06-20T12:02:00.000Z', 0.25),
      ],
      [],
    );

    expect(
      rows.map((row) =>
        row.kind === 'usage' ? [row.costUsd, row.runningCostUsd, row.runningCostIncomplete] : [],
      ),
    ).toEqual([
      [0.5, 0.5, undefined],
      [undefined, 0.5, true],
      [0.25, 0.75, true],
    ]);
  });

  it('interleaves tool calls and messages by time, after a request that shares their timestamp', () => {
    const rows = buildSessionTimeline(
      [request('2026-06-20T12:00:00.000Z', 0.5), request('2026-06-20T12:02:00.000Z', 0.5)],
      [
        toolCall('2026-06-20T12:00:00.000Z', 'Read'),
        userMessage('2026-06-20T11:59:00.000Z'),
        toolCall('2026-06-20T12:01:00.000Z', 'Bash'),
      ],
    );

    expect(rows.map((row) => (row.kind === 'tool_call' ? row.name : row.kind))).toEqual([
      'message',
      'usage',
      'Read',
      'Bash',
      'usage',
    ]);
    // Rows carry what the timeline shows, never message text.
    expect(rows[0]).toEqual({
      kind: 'message',
      timestamp: '2026-06-20T11:59:00.000Z',
      role: 'user',
    });
  });
});
