import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getDefaultCopilotOtelDir,
  CopilotSourceAdapter,
} from '../../src/sources/copilot/copilot-source-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('CopilotSourceAdapter', () => {
  it('discovers jsonl files and an explicit OTEL exporter file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-source-adapter-'));
    tempDirs.push(root);

    const nested = path.join(root, 'nested');
    await mkdir(nested, { recursive: true });

    const first = path.join(root, 'a.jsonl');
    const second = path.join(nested, 'b.jsonl');
    const envFile = path.join(root, 'exporter.jsonl');

    await writeFile(path.join(root, 'ignore.txt'), 'noop', 'utf8');
    await writeFile(second, '{}\n', 'utf8');
    await writeFile(first, '{}\n', 'utf8');
    await writeFile(envFile, '{}\n', 'utf8');

    const adapter = new CopilotSourceAdapter({
      dir: root,
      env: { COPILOT_OTEL_FILE_EXPORTER_PATH: envFile },
    });

    await expect(adapter.discoverFiles()).resolves.toEqual([
      await realpath(first),
      await realpath(envFile),
      await realpath(second),
    ]);
  });

  it('errors when an explicitly required OTEL directory is missing', async () => {
    const adapter = new CopilotSourceAdapter({
      dir: path.join(os.tmpdir(), `missing-copilot-${Date.now()}`),
      requireDir: true,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      'Copilot OTEL directory is missing or unreadable',
    );
  });

  it('parses usage candidates with class priority and cached-input subtraction', async () => {
    const adapter = new CopilotSourceAdapter();
    const filePath = path.resolve('tests/fixtures/copilot/otel.jsonl');

    const diagnostics = await adapter.parseFileWithDiagnostics(filePath);

    expect(diagnostics.skippedRows).toBe(2);
    expect(diagnostics.skippedRowReasons).toEqual([
      { reason: 'invalid_timestamp', count: 1 },
      { reason: 'no_token_usage', count: 1 },
    ]);
    expect(diagnostics.events).toHaveLength(3);
    expect(diagnostics.events.map((event) => event.sessionId)).toEqual([
      'conversation-1',
      'conversation-2',
      'interaction-3',
    ]);

    expect(diagnostics.events[0]).toMatchObject({
      source: 'copilot',
      model: 'gpt-4.1-copilot',
      inputTokens: 0,
      outputTokens: 20,
      reasoningTokens: 2,
      cacheReadTokens: 10,
      cacheWriteTokens: 3,
      totalTokens: 39,
      costMode: 'estimated',
    });
    expect(diagnostics.events[0]?.timestamp).toBe('2026-04-01T12:00:00.000Z');

    expect(diagnostics.events[1]).toMatchObject({
      model: 'claude-agent-copilot',
      inputTokens: 25,
      outputTokens: 10,
      cacheReadTokens: 5,
      totalTokens: 45,
    });

    expect(diagnostics.events[2]).toMatchObject({
      model: 'gpt-4o-mini-copilot',
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    });
  });

  it('keeps same-priority chat spans sharing a trace while dropping lower-priority records', async () => {
    const adapter = new CopilotSourceAdapter();
    const filePath = path.resolve('tests/fixtures/copilot/otel-same-trace.jsonl');

    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.totalTokens)).toEqual([50, 20]);
    expect(events.reduce((sum, event) => sum + event.totalTokens, 0)).toBe(70);
    expect(events[0]).toMatchObject({ inputTokens: 40, outputTokens: 10 });
    expect(events[1]).toMatchObject({ inputTokens: 15, outputTokens: 5 });
  });

  it('falls back to the file stem when no session identifiers are present', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-fallback-session-'));
    tempDirs.push(root);
    const filePath = path.join(root, 'fallback.jsonl');

    await writeFile(
      filePath,
      `${JSON.stringify({
        name: 'chat completion',
        timestamp: '2026-04-01T12:00:00.000Z',
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.usage.input_tokens': 1,
          'gen_ai.usage.output_tokens': 2,
        },
      })}\n`,
      'utf8',
    );

    const adapter = new CopilotSourceAdapter({ dir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBe('fallback');
  });

  it('reports malformed JSONL lines that pass its prefilter', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-malformed-jsonl-'));
    tempDirs.push(root);
    const filePath = path.join(root, 'session.jsonl');

    await writeFile(filePath, '{"attributes":', 'utf8');

    const adapter = new CopilotSourceAdapter({ dir: root });
    const diagnostics = await adapter.parseFileWithDiagnostics(filePath);

    expect(diagnostics.events).toEqual([]);
    expect(diagnostics.skippedRows).toBe(1);
    expect(diagnostics.skippedRowReasons).toEqual([{ reason: 'json_parse_error', count: 1 }]);
  });

  it('returns the documented default OTEL directory', () => {
    expect(getDefaultCopilotOtelDir()).toBe(path.join(os.homedir(), '.copilot', 'otel'));
  });
});
