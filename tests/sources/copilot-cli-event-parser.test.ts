import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCopilotCliEvents } from '../../src/sources/copilot-cli/copilot-cli-event-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'copilot-cli');

describe('parseCopilotCliEvents', () => {
  it('pairs queued user timestamps with assistant turns in FIFO order', async () => {
    const filePath = path.join(fixturesDir, 'session-flat.jsonl');
    const content = await readFile(filePath, 'utf8');

    const result = parseCopilotCliEvents(filePath, content);

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      source: 'copilot-cli',
      sessionId: 'cli-flat-001',
      timestamp: '2026-02-20T10:00:02.000Z',
      repoRoot: '/workspace/flat',
      provider: 'github',
      model: 'gpt-4o',
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costMode: 'estimated',
    });
    expect(result.events[1]?.timestamp).toBe('2026-02-20T10:00:03.000Z');
  });

  it('handles orphan assistant.turn_end by falling back to turn-end timestamp', async () => {
    const filePath = path.join(fixturesDir, 'session-with-orphan-turn-end.jsonl');
    const content = await readFile(filePath, 'utf8');

    const result = parseCopilotCliEvents(filePath, content);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.timestamp).toBe('2026-02-24T09:00:02.000Z');
  });

  it('tracks model updates from session.model_change', () => {
    const content = [
      '{"type":"session.start","data":{"sessionId":"model-switch"}}',
      '{"type":"session.model_change","data":{"model":"gpt-4o"}}',
      '{"type":"user.message","timestamp":"2026-02-25T10:00:00.000Z"}',
      '{"type":"assistant.turn_end","timestamp":"2026-02-25T10:00:01.000Z"}',
      '{"type":"session.model_change","data":{"model":"claude-3.7-sonnet"}}',
      '{"type":"user.message","timestamp":"2026-02-25T10:00:02.000Z"}',
      '{"type":"assistant.turn_end","timestamp":"2026-02-25T10:00:03.000Z"}',
    ].join('\n');

    const result = parseCopilotCliEvents('/tmp/model-switch.jsonl', content);

    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.model).toBe('gpt-4o');
    expect(result.events[1]?.model).toBe('claude-3.7-sonnet');
  });

  it('applies workspace fallback metadata only when event metadata is missing', async () => {
    const fallbackFilePath = path.join(fixturesDir, 'session-dir', 'events.jsonl');
    const fallbackContent = await readFile(fallbackFilePath, 'utf8');
    const fallbackResult = parseCopilotCliEvents(fallbackFilePath, fallbackContent, {
      id: 'workspace-session-id',
      cwd: '/workspace/from-yaml',
    });

    expect(fallbackResult.events).toHaveLength(1);
    expect(fallbackResult.events[0]?.sessionId).toBe('workspace-session-id');
    expect(fallbackResult.events[0]?.repoRoot).toBe('/workspace/from-yaml');

    const eventPreferredFilePath = path.join(
      fixturesDir,
      'session-with-truncation',
      'events.jsonl',
    );
    const eventPreferredContent = await readFile(eventPreferredFilePath, 'utf8');
    const eventPreferredResult = parseCopilotCliEvents(
      eventPreferredFilePath,
      eventPreferredContent,
      {
        id: 'workspace-fallback-id',
        cwd: '/workspace/from-workspace',
      },
    );

    expect(eventPreferredResult.events).toHaveLength(1);
    expect(eventPreferredResult.events[0]?.sessionId).toBe('session-from-event');
    expect(eventPreferredResult.events[0]?.repoRoot).toBe('/workspace/from-event');
  });

  it('ignores session.truncation for emitted events and records skipped info', async () => {
    const filePath = path.join(fixturesDir, 'session-with-truncation', 'events.jsonl');
    const content = await readFile(filePath, 'utf8');

    const result = parseCopilotCliEvents(filePath, content);

    expect(result.events).toHaveLength(1);
    expect(result.skippedRows).toBe(1);
    expect(result.skippedRowReasons).toEqual([{ reason: 'unsupported_event_type', count: 1 }]);
  });

  it('reports skipped rows for malformed relevant records', () => {
    const content = [
      '{"type":"user.message","timestamp":"2026-02-25T10:00:00.000Z"}',
      '{"type":"assistant.turn_end","timestamp":"2026-02-25T10:00:01.000Z"}',
      '{"type":"session.model_change"',
      '{"type":"assistant.turn_end"}',
    ].join('\n');

    const result = parseCopilotCliEvents('/tmp/malformed.jsonl', content);

    expect(result.events).toHaveLength(1);
    expect(result.skippedRows).toBe(2);
    expect(result.skippedRowReasons).toEqual([
      { reason: 'json_parse_error', count: 1 },
      { reason: 'missing_timestamp', count: 1 },
    ]);
  });
});
