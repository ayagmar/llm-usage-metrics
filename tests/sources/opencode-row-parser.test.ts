import { describe, expect, it } from 'vitest';

import { parseOpenCodeMessageRows } from '../../src/sources/opencode/opencode-row-parser.js';

describe('opencode row parser', () => {
  it('parses valid assistant rows and skips malformed/non-usable rows with diagnostics', () => {
    const parseDiagnostics = parseOpenCodeMessageRows(
      [
        {
          row_id: 'msg-1',
          row_session_id: 'session-1',
          row_time: 1_737_000_000,
          data_json: JSON.stringify({
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-5-codex',
            path: {
              root: '/tmp/opencode-repo',
              cwd: '/tmp/opencode-repo/app',
            },
            tokens: {
              input: 100,
              output: 40,
              reasoning: 5,
              cache: { read: 20, write: 10 },
              total: 175,
            },
            cost: 1.5,
          }),
        },
        {
          row_id: 'msg-2',
          row_session_id: 'session-2',
          row_time: 1_737_000_001,
          data_json: '{invalid',
        },
        {
          row_id: 'msg-2b',
          row_session_id: 'session-2b',
          row_time: 1_737_000_001_500,
          data_json: '[]',
        },
        {
          row_id: 'msg-3',
          row_session_id: 'session-3',
          row_time: 1_737_000_002,
          data_json: JSON.stringify({ role: 'user', tokens: { input: 999 } }),
        },
        {
          row_id: 'msg-4',
          row_session_id: 'session-4',
          row_time: 'not-a-timestamp',
          data_json: JSON.stringify({
            role: 'assistant',
            modelID: 'gpt-4.1',
            tokens: { input: 1, output: 1, total: 2 },
          }),
        },
        {
          row_id: '',
          row_session_id: '',
          row_time: 1_737_000_004,
          data_json: JSON.stringify({
            role: 'assistant',
            sessionID: '   ',
            sessionId: '',
            session_id: '',
            modelID: 'gpt-4.1',
            tokens: { input: 1, output: 1, total: 2 },
          }),
        },
        {
          row_id: 'msg-6',
          row_session_id: 'session-6',
          row_time: 1_737_000_005,
          data_json: JSON.stringify({
            role: 'assistant',
            modelID: 'gpt-4.1',
            tokens: { input: 0, output: 0, total: 0 },
          }),
        },
      ],
      'opencode',
    );

    expect(parseDiagnostics.events).toHaveLength(1);
    expect(parseDiagnostics.skippedRows).toBe(5);
    expect(parseDiagnostics.skippedRowReasons).toEqual([
      { reason: 'invalid_data_json', count: 2 },
      { reason: 'missing_session_id', count: 1 },
      { reason: 'missing_timestamp', count: 1 },
      { reason: 'missing_usage_signal', count: 1 },
    ]);
    expect(parseDiagnostics.events[0]).toMatchObject({
      source: 'opencode',
      sessionId: 'session-1',
      timestamp: new Date(1_737_000_000 * 1000).toISOString(),
      repoRoot: '/tmp/opencode-repo',
      provider: 'openai',
      model: 'gpt-5-codex',
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 5,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 175,
      costUsd: 1.5,
      costMode: 'explicit',
    });
  });

  it('uses payload timestamps/session fallbacks and row id fallback for session id', () => {
    const parseDiagnostics = parseOpenCodeMessageRows(
      [
        {
          row_id: 'msg-fallback-id',
          row_time: undefined,
          data_json: JSON.stringify({
            role: 'assistant',
            model: 'gpt-4.1',
            tokens: { input: 2, output: 3, total: 5 },
            timestamp: '2026-02-14T10:00:00.000Z',
          }),
        },
        {
          row_id: 'msg-payload-session',
          row_time: undefined,
          data_json: JSON.stringify({
            type: 'assistant',
            sessionID: 'session-from-payload',
            provider: 'anthropic',
            model: 'claude-sonnet-4.5',
            timeCreated: 1_737_000_010_000,
            tokens: { input: 10, output: 20 },
          }),
        },
      ],
      'opencode',
    );

    expect(parseDiagnostics.skippedRows).toBe(0);
    expect(parseDiagnostics.skippedRowReasons).toEqual([]);
    expect(parseDiagnostics.events).toHaveLength(2);
    expect(parseDiagnostics.events[0]).toMatchObject({
      sessionId: 'msg-fallback-id',
      totalTokens: 5,
      costMode: 'estimated',
    });
    expect(parseDiagnostics.events[1]).toMatchObject({
      sessionId: 'session-from-payload',
      provider: 'anthropic',
      model: 'claude-sonnet-4.5',
      totalTokens: 30,
      timestamp: new Date(1_737_000_010_000).toISOString(),
    });
  });

  it('coerces numeric row_id fallback into a valid session id', () => {
    const parseDiagnostics = parseOpenCodeMessageRows(
      [
        {
          row_id: 42,
          row_time: 1_737_000_040_000,
          data_json: JSON.stringify({
            role: 'assistant',
            model: 'gpt-4.1',
            tokens: { input: 2, output: 3, total: 5 },
          }),
        },
      ],
      'opencode',
    );

    expect(parseDiagnostics.skippedRows).toBe(0);
    expect(parseDiagnostics.events).toHaveLength(1);
    expect(parseDiagnostics.events[0]).toMatchObject({
      sessionId: '42',
      totalTokens: 5,
    });
  });

  it('treats explicit zero cost as usage signal and keeps explicit cost mode', () => {
    const parseDiagnostics = parseOpenCodeMessageRows(
      [
        {
          row_id: 'msg-explicit-zero',
          row_session_id: 'session-explicit-zero',
          row_time: 1_737_000_020_000,
          data_json: JSON.stringify({
            role: 'assistant',
            model: 'gpt-4.1',
            tokens: { input: 0, output: 0, total: 0 },
            cost: 0,
          }),
        },
      ],
      'opencode',
    );

    expect(parseDiagnostics.skippedRows).toBe(0);
    expect(parseDiagnostics.skippedRowReasons).toEqual([]);
    expect(parseDiagnostics.events).toHaveLength(1);
    expect(parseDiagnostics.events[0]).toMatchObject({
      sessionId: 'session-explicit-zero',
      totalTokens: 0,
      costUsd: 0,
      costMode: 'explicit',
    });
  });

  it('preserves total-only usage without inventing billable buckets', () => {
    const parseDiagnostics = parseOpenCodeMessageRows(
      [
        {
          row_id: 'msg-total-only',
          row_session_id: 'session-total-only',
          row_time: 1_737_000_025_000,
          data_json: JSON.stringify({
            role: 'assistant',
            providerID: 'openai',
            modelID: 'gpt-5.2',
            tokens: { total: 21 },
          }),
        },
      ],
      'opencode',
    );

    expect(parseDiagnostics.skippedRows).toBe(0);
    expect(parseDiagnostics.skippedRowReasons).toEqual([]);
    expect(parseDiagnostics.events).toHaveLength(1);
    expect(parseDiagnostics.events[0]).toMatchObject({
      sessionId: 'session-total-only',
      provider: 'openai',
      model: 'gpt-5.2',
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 21,
      costUsd: undefined,
      costMode: 'estimated',
    });
  });

  it('treats blank string cost as absent instead of explicit zero', () => {
    const parseDiagnostics = parseOpenCodeMessageRows(
      [
        {
          row_id: 'msg-empty-cost',
          row_session_id: 'session-empty-cost',
          row_time: 1_737_000_030_000,
          data_json: JSON.stringify({
            role: 'assistant',
            model: 'gpt-4.1',
            tokens: { input: 0, output: 0, total: 0 },
            cost: '   ',
          }),
        },
      ],
      'opencode',
    );

    expect(parseDiagnostics.events).toHaveLength(0);
    expect(parseDiagnostics.skippedRows).toBe(1);
    expect(parseDiagnostics.skippedRowReasons).toEqual([
      { reason: 'missing_usage_signal', count: 1 },
    ]);
  });
});
