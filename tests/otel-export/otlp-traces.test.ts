import { createToolCallEvent, type ToolCallEventInput } from '@ayagmar/agent-sessions';
import { describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import { buildOtlpTraces } from '../../src/otel-export/otlp-traces.js';

function event(timestamp: string, inputTokens: number, provider = 'openai') {
  return createUsageEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp,
    provider,
    model: 'gpt-4.1',
    inputTokens,
    outputTokens: 5,
  });
}

function toolCall(timestamp: string, overrides: Partial<ToolCallEventInput> = {}) {
  return createToolCallEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp,
    name: 'shell',
    status: 'ok',
    ...overrides,
  });
}

describe('buildOtlpTraces span ids', () => {
  // Two same-timestamp events and two id-less calls of one name exercise the occurrence index.
  const usageEvents = [
    event('2026-01-04T10:00:00.000Z', 100),
    event('2026-02-02T10:00:00.000Z', 20),
    event('2026-02-02T10:00:00.000Z', 30),
  ];
  const toolCalls = [
    toolCall('2026-01-04T10:00:01.000Z'),
    toolCall('2026-02-02T10:00:01.000Z'),
    toolCall('2026-02-02T10:00:01.000Z', { name: 'read' }),
    toolCall('2026-02-02T10:00:02.000Z', { toolCallId: 'call-1' }),
  ];

  it('gives an event and an id-less tool call the same span id in every window that holds it', () => {
    const all = buildOtlpTraces({ usageEvents, toolCalls });
    const january = buildOtlpTraces({
      usageEvents: usageEvents.slice(0, 1),
      toolCalls: toolCalls.slice(0, 1),
    });
    const february = buildOtlpTraces({
      usageEvents: usageEvents.slice(1),
      toolCalls: toolCalls.slice(1),
    });
    const allSpanIds = all[0].resourceSpans[0].scopeSpans[0].spans.map((span) => span.spanId);
    const windowSpanIds = [...january, ...february]
      .flatMap((data) => data.resourceSpans[0].scopeSpans[0].spans)
      .filter((span) => span.parentSpanId !== undefined)
      .map((span) => span.spanId);

    expect(new Set(allSpanIds).size).toBe(allSpanIds.length);
    expect(windowSpanIds).toHaveLength(usageEvents.length + toolCalls.length);
    expect(new Set(windowSpanIds).size).toBe(windowSpanIds.length);
    expect(allSpanIds).toEqual(expect.arrayContaining(windowSpanIds));
  });

  it('keeps a chat span id under a provider filter that drops a same-instant request', () => {
    const pair = [
      event('2026-03-01T10:00:00.000Z', 10, 'openai'),
      event('2026-03-01T10:00:00.000Z', 20, 'azure'),
    ];
    const chatSpanIds = (events: typeof pair) =>
      buildOtlpTraces({ usageEvents: events, toolCalls: [] })[0]
        .resourceSpans[0].scopeSpans[0].spans.filter((span) => span.parentSpanId !== undefined)
        .map((span) => span.spanId);

    expect(chatSpanIds(pair)).toContain(chatSpanIds(pair.slice(1))[0]);
    expect(chatSpanIds(pair.slice(1))).not.toEqual(chatSpanIds(pair.slice(0, 1)));
  });
});
