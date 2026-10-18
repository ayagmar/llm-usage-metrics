import { describe, expect, it } from 'vitest';

import {
  EVENT_KINDS,
  createMessageEvent,
  createSessionMetaEvent,
  createToolCallEvent,
  createUsageRecord,
  isUsageEvent,
  isUsageRecord,
  type EventKind,
  type MessageEvent,
  type SessionEvent,
  type ToolCallStatus,
} from '../../src/domain/session-event.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';

const base = { source: 'claude', sessionId: 'session-1', timestamp: '2026-06-01T10:00:00Z' };

describe('EVENT_KINDS', () => {
  it('lists the four kinds, usage first', () => {
    expect(EVENT_KINDS).toEqual(['usage', 'message', 'tool_call', 'session_meta']);
  });

  it('cannot be changed at runtime, so no caller changes what an adapter declares', () => {
    expect(() => {
      (EVENT_KINDS as EventKind[]).push('usage');
    }).toThrow(TypeError);
    expect(EVENT_KINDS).toHaveLength(4);
  });
});

describe('createUsageRecord', () => {
  const usage = {
    ...base,
    provider: 'Anthropic',
    model: 'Claude-Sonnet-4-5',
    inputTokens: 10,
    outputTokens: 5,
  };

  it('is the usage event read yields, keys in the same order, after kind', () => {
    const record = createUsageRecord(usage);
    const { kind, ...rest } = record;

    expect(kind).toBe('usage');
    expect(Object.keys(record)[0]).toBe('kind');
    expect(JSON.stringify(rest)).toBe(JSON.stringify(createUsageEvent(usage)));
    // Present-but-undefined keys match too, as toStrictEqual checks.
    expect(rest).toStrictEqual(createUsageEvent(usage));
  });

  it('appends ids and the logged provider when defined, cleaned and trimmed', () => {
    const record = createUsageRecord({
      ...usage,
      messageId: ' msg_1\u0007 ',
      requestId: 'req_1',
      rawProvider: ' Anthropic-Vertex ',
    });

    expect(record).toMatchObject({
      provider: 'anthropic',
      messageId: 'msg_1',
      requestId: 'req_1',
      rawProvider: 'Anthropic-Vertex',
    });
    expect(Object.keys(record).slice(-3)).toEqual(['messageId', 'requestId', 'rawProvider']);
  });

  it('leaves out undefined or blank ids and raw', () => {
    const record = createUsageRecord({ ...usage, messageId: '  ', rawProvider: undefined });

    expect(record).not.toHaveProperty('messageId');
    expect(record).not.toHaveProperty('requestId');
    expect(record).not.toHaveProperty('rawProvider');
    expect(record).not.toHaveProperty('raw');
  });

  it('carries raw only when given', () => {
    const raw = { type: 'assistant' };

    expect(createUsageRecord({ ...usage, raw }).raw).toBe(raw);
  });

  it('rejects what createUsageEvent rejects', () => {
    expect(() => createUsageRecord({ ...usage, sessionId: ' ' })).toThrow();
    expect(() => createUsageRecord({ ...usage, timestamp: 'nope' })).toThrow();
  });
});

describe('createMessageEvent', () => {
  it('keeps text exactly as given, and only when given', () => {
    const text = '  hello\u0007\n\nworld  ';
    const event = createMessageEvent({ ...base, role: 'user', textLength: text.length, text });

    expect(event).toStrictEqual({
      kind: 'message',
      source: 'claude',
      sessionId: 'session-1',
      timestamp: '2026-06-01T10:00:00.000Z',
      role: 'user',
      textLength: text.length,
      text,
    });
    expect(
      createMessageEvent({ ...base, role: 'user', textLength: text.length }),
    ).not.toHaveProperty('text');
  });

  it('normalizes the model and ids, and counts a non-negative integer length', () => {
    const event = createMessageEvent({
      ...base,
      role: 'assistant',
      messageId: ' msg_1 ',
      model: ' Claude-Opus-4-1 ',
      textLength: -3,
    });

    expect(event).toMatchObject({ messageId: 'msg_1', model: 'claude-opus-4-1', textLength: 0 });
    expect(createMessageEvent({ ...base, role: 'system', textLength: 7.9 }).textLength).toBe(7);
  });

  it('needs a source, a session id and a valid timestamp', () => {
    const message = { role: 'user', textLength: 1 } as const;

    expect(() => createMessageEvent({ ...base, ...message, source: ' ' })).toThrow(/source/);
    expect(() => createMessageEvent({ ...base, ...message, sessionId: '\u0000' })).toThrow(
      /sessionId/,
    );
    expect(() => createMessageEvent({ ...base, ...message, timestamp: 'later' })).toThrow();
  });

  it('rejects a role outside the union, such as one read from an untrusted record', () => {
    for (const role of ['constructor', 'developer', '']) {
      expect(() =>
        createMessageEvent({ ...base, role: role as MessageEvent['role'], textLength: 1 }),
      ).toThrow(/role/);
    }
  });
});

describe('createToolCallEvent', () => {
  it('normalizes ids, name, completion time and duration', () => {
    const event = createToolCallEvent({
      ...base,
      toolCallId: ' toolu_1 ',
      name: ' Bash\u0007 ',
      status: 'ok',
      completedAt: '2026-06-01T10:00:02Z',
      durationMs: 1500.7,
      messageId: 'msg_1',
    });

    expect(event).toStrictEqual({
      kind: 'tool_call',
      source: 'claude',
      sessionId: 'session-1',
      timestamp: '2026-06-01T10:00:00.000Z',
      name: 'Bash',
      status: 'ok',
      toolCallId: 'toolu_1',
      completedAt: '2026-06-01T10:00:02.000Z',
      durationMs: 1500,
      messageId: 'msg_1',
    });
  });

  it('leaves out what was not logged', () => {
    expect(
      createToolCallEvent({ ...base, name: 'Read', status: 'unknown', durationMs: null }),
    ).toStrictEqual({
      kind: 'tool_call',
      source: 'claude',
      sessionId: 'session-1',
      timestamp: '2026-06-01T10:00:00.000Z',
      name: 'Read',
      status: 'unknown',
    });
  });

  it('needs a name', () => {
    expect(() => createToolCallEvent({ ...base, name: ' ', status: 'ok' })).toThrow(/name/);
  });

  it('rejects a status outside the union', () => {
    for (const status of ['completed', 'toString']) {
      expect(() =>
        createToolCallEvent({ ...base, name: 'Read', status: status as ToolCallStatus }),
      ).toThrow(/status/);
    }
  });
});

describe('createSessionMetaEvent', () => {
  it('cleans each field and leaves out blank ones', () => {
    expect(
      createSessionMetaEvent({
        ...base,
        cwd: ' /work/repo ',
        title: '\u0007',
        gitBranch: 'main',
        model: 'GPT-5',
        rawProvider: ' OpenAI ',
      }),
    ).toStrictEqual({
      kind: 'session_meta',
      source: 'claude',
      sessionId: 'session-1',
      timestamp: '2026-06-01T10:00:00.000Z',
      cwd: '/work/repo',
      gitBranch: 'main',
      model: 'gpt-5',
      rawProvider: 'OpenAI',
    });
  });
});

describe('constructors are idempotent', () => {
  // I6 re-creates every event from its own fields.
  it.each([
    createUsageRecord({ ...base, inputTokens: 3, messageId: 'm', raw: { a: 1 } }),
    createMessageEvent({ ...base, role: 'assistant', model: 'X', textLength: 2, text: 'hi' }),
    createToolCallEvent({ ...base, name: 'Edit', status: 'error', completedAt: base.timestamp }),
    createSessionMetaEvent({ ...base, title: 'A title', agentVersion: '2.0.1' }),
  ] satisfies SessionEvent[])('%#', (event) => {
    const recreate = {
      usage: createUsageRecord,
      message: createMessageEvent,
      tool_call: createToolCallEvent,
      session_meta: createSessionMetaEvent,
    } as const;
    // Each constructor takes its own event back as input.
    const recreated = (recreate[event.kind] as (input: SessionEvent) => SessionEvent)(event);

    expect(recreated).toStrictEqual(event);
  });
});

describe('usage guards', () => {
  const plain = createUsageEvent({ ...base, inputTokens: 1 });
  const record = createUsageRecord({ ...base, inputTokens: 1 });
  const message = createMessageEvent({ ...base, role: 'user', textLength: 0 });

  it('isUsageRecord tells usage records from other kinds', () => {
    expect(isUsageRecord(record)).toBe(true);
    expect(isUsageRecord(message)).toBe(false);
  });

  it('isUsageEvent accepts a plain usage event and a usage record only', () => {
    expect(isUsageEvent(plain)).toBe(true);
    expect(isUsageEvent(record)).toBe(true);
    expect(isUsageEvent(message)).toBe(false);
  });
});
