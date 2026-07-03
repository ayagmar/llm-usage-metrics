import { copyFile, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getDefaultOpenClawAgentsDir,
  OpenClawSourceAdapter,
} from '../../src/sources/openclaw/openclaw-source-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('OpenClawSourceAdapter', () => {
  it('discovers jsonl files recursively in deterministic order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-source-adapter-'));
    tempDirs.push(root);

    const nested = path.join(root, 'main', 'sessions');
    await mkdir(nested, { recursive: true });

    const first = path.join(root, 'a.jsonl');
    const second = path.join(nested, 'b.jsonl');

    await writeFile(path.join(root, 'ignore.txt'), 'noop', 'utf8');
    await writeFile(second, '{}\n', 'utf8');
    await writeFile(first, '{}\n', 'utf8');

    const adapter = new OpenClawSourceAdapter({ agentsDir: root });

    await expect(adapter.discoverFiles()).resolves.toEqual([
      await realpath(first),
      await realpath(second),
    ]);
  });

  it('parses assistant usage while tracking provider and model changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-session-mixed-'));
    tempDirs.push(root);

    // Copy the fixture so the mtime tweak never touches the checked-in file.
    const fixturePath = path.join(root, 'session-mixed.jsonl');
    await copyFile(path.resolve('tests/fixtures/openclaw/session-mixed.jsonl'), fixturePath);
    const fileMtime = new Date('2026-04-01T10:03:00.000Z');
    await utimes(fixturePath, fileMtime, fileMtime);

    const adapter = new OpenClawSourceAdapter();
    const events = await adapter.parseFile(fixturePath);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      source: 'openclaw',
      sessionId: 'openclaw-session-1',
      repoRoot: '/tmp/openclaw-repo',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 10,
      cacheWriteTokens: 3,
      totalTokens: 133,
      costUsd: 0.0123,
      costMode: 'explicit',
    });

    expect(events[1]).toMatchObject({
      source: 'openclaw',
      sessionId: 'openclaw-session-1',
      repoRoot: '/tmp/openclaw-repo-2',
      provider: 'openai',
      model: 'gpt-5.3-codex',
      inputTokens: 7,
      outputTokens: 11,
      reasoningTokens: 2,
      cacheReadTokens: 5,
      totalTokens: 25,
      costUsd: 0.0042,
      costMode: 'explicit',
    });

    expect(events[2]).toMatchObject({
      source: 'openclaw',
      sessionId: 'openclaw-session-1',
      repoRoot: '/tmp/openclaw-repo-2',
      provider: 'google',
      model: 'gemini-3-pro',
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
      costMode: 'estimated',
    });
    expect(events[2]?.timestamp).toBe('2026-04-01T10:03:00.000Z');
  });

  it('falls back to message.usage when line-level usage is malformed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-message-usage-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'openclaw-message-usage',
          timestamp: '2026-04-02T20:00:00.000Z',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-04-02T20:01:00.000Z',
          usage: 'unexpected-string',
          message: {
            role: 'assistant',
            usage: {
              input_tokens: 4,
              output_tokens: 6,
              total_tokens: 10,
              cost: 0.006,
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new OpenClawSourceAdapter({ agentsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
      costUsd: 0.006,
      costMode: 'explicit',
    });
  });

  it('keeps assistant usage that inherits state after a delivery-mirror row', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-mirror-state-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'openclaw-mirror-state',
          timestamp: '2026-04-05T20:00:00.000Z',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        }),
        JSON.stringify({
          type: 'message',
          id: 'mirror',
          role: 'assistant',
          timestamp: '2026-04-05T20:01:00.000Z',
          provider: 'openclaw',
          model: 'delivery-mirror',
          usage: { input: 999, output: 999, total: 1998, cost: { total: 9.99 } },
        }),
        JSON.stringify({
          type: 'message',
          id: 'real',
          role: 'assistant',
          timestamp: '2026-04-05T20:02:00.000Z',
          usage: { input: 10, output: 5, total: 15 },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new OpenClawSourceAdapter({ agentsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('attributes snake_case model_provider/model_id aliases to the row itself', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-snake-aliases-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'openclaw-snake-aliases',
          timestamp: '2026-04-06T20:00:00.000Z',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          timestamp: '2026-04-06T20:01:00.000Z',
          model_provider: 'openai',
          model_id: 'gpt-5.3-codex',
          usage: { input: 10, output: 5, total: 15 },
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-04-06T20:02:00.000Z',
          message: {
            role: 'assistant',
            model_provider: 'google',
            model_id: 'gemini-3-pro',
            usage: { input: 6, output: 2, total: 8 },
          },
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          timestamp: '2026-04-06T20:03:00.000Z',
          usage: { input: 3, output: 1, total: 4 },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new OpenClawSourceAdapter({ agentsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.3-codex',
    });
    expect(events[1]).toMatchObject({
      provider: 'google',
      model: 'gemini-3-pro',
    });
    // The bare row inherits the nested snake_case aliases through runtime state.
    expect(events[2]).toMatchObject({
      provider: 'google',
      model: 'gemini-3-pro',
    });
  });

  it('keeps real usage when the session provider is openclaw', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-gateway-provider-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'openclaw-gateway-provider',
          timestamp: '2026-04-07T20:00:00.000Z',
          provider: 'openclaw',
          model: 'claude-sonnet-4-6',
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          timestamp: '2026-04-07T20:01:00.000Z',
          usage: { input: 10, output: 5, total: 15 },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new OpenClawSourceAdapter({ agentsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'openclaw',
      model: 'claude-sonnet-4-6',
      totalTokens: 15,
    });
  });

  it('merges line-level tokens with nested message cost', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-merged-usage-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'openclaw-merged-usage',
          timestamp: '2026-04-03T20:00:00.000Z',
          provider: 'openai',
          model: 'gpt-5.3-codex',
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          timestamp: '2026-04-03T20:01:00.000Z',
          usage: {
            input: 10,
            output: 4,
            total: 14,
          },
          message: {
            usage: {
              cost: {
                total: 0.0025,
              },
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new OpenClawSourceAdapter({ agentsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      costUsd: 0.0025,
      costMode: 'explicit',
    });
  });

  it('reports invalid usage events through parse diagnostics', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-invalid-event-'));
    tempDirs.push(root);

    const filePath = path.join(root, '.jsonl');

    await writeFile(
      filePath,
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        timestamp: '2026-04-03T20:01:00.000Z',
        usage: {
          input: 10,
          output: 4,
          total: 14,
        },
      }),
      'utf8',
    );

    const adapter = new OpenClawSourceAdapter({ agentsDir: root });
    Object.defineProperty(adapter, 'id', { value: ' ' });
    const diagnostics = await adapter.parseFileWithDiagnostics(filePath);

    expect(diagnostics.events).toEqual([]);
    expect(diagnostics.skippedRows).toBe(1);
    expect(diagnostics.skippedRowReasons).toEqual([
      {
        reason: 'invalid_usage_event',
        count: 1,
      },
    ]);
  });

  it('fails discovery when an explicitly configured directory is missing', async () => {
    const adapter = new OpenClawSourceAdapter({
      agentsDir: path.join(os.tmpdir(), `missing-openclaw-${Date.now()}`),
      requireAgentsDir: true,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      'OpenClaw agents directory is missing or unreadable',
    );
  });

  it('fails discovery when an explicitly configured path is a file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openclaw-file-path-'));
    tempDirs.push(root);
    const filePath = path.join(root, 'session.jsonl');
    await writeFile(filePath, '{}\n', 'utf8');

    const adapter = new OpenClawSourceAdapter({
      agentsDir: filePath,
      requireAgentsDir: true,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      `OpenClaw agents directory is not a directory: ${filePath}`,
    );
  });

  it('uses the default OpenClaw agents directory', () => {
    expect(getDefaultOpenClawAgentsDir()).toBe(path.join(os.homedir(), '.openclaw', 'agents'));
  });
});
