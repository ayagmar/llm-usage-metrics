import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCopilotVscodeSession } from '../../src/sources/copilot-vscode/copilot-vscode-session-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'copilot-vscode', 'workspaceStorage');

describe('parseCopilotVscodeSession', () => {
  it('converts epoch-ms timestamps to ISO', async () => {
    const filePath = path.join(fixturesDir, 'hash-a', 'chatSessions', 'session-basic.json');
    const content = await readFile(filePath, 'utf8');

    const result = parseCopilotVscodeSession(filePath, content);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.timestamp).toBe('2024-10-27T03:33:20.000Z');
  });

  it('applies repoRoot precedence (request response first, then session-level fallback)', async () => {
    const filePath = path.join(fixturesDir, 'hash-b', 'chatSessions', 'session-multi-model.json');
    const content = await readFile(filePath, 'utf8');

    const result = parseCopilotVscodeSession(filePath, content);

    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.repoRoot).toBe('/workspace/multi');
    expect(result.events[1]?.repoRoot).toBe('/workspace/multi');
  });

  it('skips invalid request entries and records diagnostics', async () => {
    const filePath = path.join(
      fixturesDir,
      'hash-d',
      'chatSessions',
      'session-invalid-entries.json',
    );
    const content = await readFile(filePath, 'utf8');

    const result = parseCopilotVscodeSession(filePath, content);

    expect(result.events).toHaveLength(1);
    expect(result.skippedRows).toBe(2);
    expect(result.skippedRowReasons).toEqual([
      { reason: 'invalid_request', count: 1 },
      { reason: 'invalid_timestamp', count: 1 },
    ]);
  });

  it('maps modelId per request', async () => {
    const filePath = path.join(fixturesDir, 'hash-b', 'chatSessions', 'session-multi-model.json');
    const content = await readFile(filePath, 'utf8');

    const result = parseCopilotVscodeSession(filePath, content);

    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.model).toBe('gpt-4o');
    expect(result.events[1]?.model).toBe('claude-3.7-sonnet');
  });

  it('falls back to file basename when top-level sessionId is missing', async () => {
    const filePath = path.join(
      fixturesDir,
      'hash-d',
      'chatSessions',
      'session-invalid-entries.json',
    );
    const content = await readFile(filePath, 'utf8');

    const result = parseCopilotVscodeSession(filePath, content);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.sessionId).toBe('session-invalid-entries');
  });

  it('reports json_parse_error for invalid json payload', () => {
    const result = parseCopilotVscodeSession('/tmp/session.json', '{invalid');

    expect(result.events).toEqual([]);
    expect(result.skippedRows).toBe(1);
    expect(result.skippedRowReasons).toEqual([{ reason: 'json_parse_error', count: 1 }]);
  });

  it('reports invalid_session_data when top-level payload is not an object', () => {
    const result = parseCopilotVscodeSession('/tmp/session.json', '["not-an-object"]');

    expect(result.events).toEqual([]);
    expect(result.skippedRows).toBe(1);
    expect(result.skippedRowReasons).toEqual([{ reason: 'invalid_session_data', count: 1 }]);
  });

  it('reports invalid_requests_array when requests is missing', () => {
    const result = parseCopilotVscodeSession('/tmp/session.json', '{"sessionId":"x"}');

    expect(result.events).toEqual([]);
    expect(result.skippedRows).toBe(1);
    expect(result.skippedRowReasons).toEqual([{ reason: 'invalid_requests_array', count: 1 }]);
  });
});
