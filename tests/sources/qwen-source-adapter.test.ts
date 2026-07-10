import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getDefaultQwenProjectsDir,
  QwenSourceAdapter,
} from '../../src/sources/qwen/qwen-source-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('QwenSourceAdapter', () => {
  it('uses the stable default projects directory', () => {
    expect(getDefaultQwenProjectsDir()).toBe(path.join(os.homedir(), '.qwen', 'projects'));
  });

  it('discovers jsonl files recursively in deterministic order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-source-adapter-'));
    tempDirs.push(root);

    const nestedChatsDir = path.join(root, 'nested', 'chats');
    await mkdir(nestedChatsDir, { recursive: true });

    const first = path.join(root, 'demo', 'chats', 'a.jsonl');
    const second = path.join(nestedChatsDir, 'b.jsonl');
    await mkdir(path.dirname(first), { recursive: true });

    await writeFile(path.join(root, 'ignore.txt'), 'noop', 'utf8');
    await writeFile(second, '{}\n', 'utf8');
    await writeFile(first, '{}\n', 'utf8');

    const adapter = new QwenSourceAdapter({ projectsDir: root });

    await expect(adapter.discoverFiles()).resolves.toEqual([
      await realpath(first),
      await realpath(second),
    ]);
  });

  it('returns no files when the default directory is missing', async () => {
    const missingRoot = path.join(os.tmpdir(), `missing-qwen-${Date.now()}`);
    const adapter = new QwenSourceAdapter({ projectsDir: missingRoot });

    await expect(adapter.discoverFiles()).resolves.toEqual([]);
  });

  it('rejects blank projects directories', async () => {
    const adapter = new QwenSourceAdapter({ projectsDir: '   ' });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      'Qwen projects directory must be a non-empty path',
    );
  });

  it('errors when an explicit projects directory is missing', async () => {
    const missingRoot = path.join(os.tmpdir(), `missing-qwen-required-${Date.now()}`);
    const adapter = new QwenSourceAdapter({
      projectsDir: missingRoot,
      requireProjectsDir: true,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      'Qwen projects directory is missing or unreadable',
    );
  });

  it('errors when an explicit projects path is a file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-file-path-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'projects.jsonl');
    await writeFile(filePath, '{}\n', 'utf8');
    const adapter = new QwenSourceAdapter({ projectsDir: filePath, requireProjectsDir: true });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      `Qwen projects directory is not a directory: ${filePath}`,
    );
  });

  it('parses assistant usageMetadata rows and reports skipped usage rows', async () => {
    const fixturePath = path.resolve('tests/fixtures/qwen/projects/demo/chats/usage.jsonl');
    const adapter = new QwenSourceAdapter();

    const result = await adapter.parseFileWithDiagnostics(fixturePath);

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      source: 'qwen',
      sessionId: 'qwen-session-1',
      timestamp: '2026-03-01T10:00:00.000Z',
      model: 'qwen3-coder',
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 15,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      totalTokens: 160,
      costMode: 'estimated',
    });
    expect(result.events[0]?.provider).toBeUndefined();
    expect(result.events[0]?.repoRoot).toBeUndefined();

    expect(result.events[1]).toMatchObject({
      source: 'qwen',
      sessionId: 'demo-usage',
      timestamp: '2026-03-01T10:01:00.000Z',
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costMode: 'estimated',
    });

    expect(result.skippedRows).toBe(2);
    expect(result.skippedRowReasons).toEqual([
      { reason: 'invalid_timestamp', count: 1 },
      { reason: 'no_token_usage', count: 1 },
    ]);
  });

  it('reports malformed JSONL lines that pass its prefilter', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-malformed-jsonl-'));
    tempDirs.push(root);
    const filePath = path.join(root, 'session.jsonl');

    await writeFile(filePath, '{"usageMetadata":', 'utf8');

    const adapter = new QwenSourceAdapter({ projectsDir: root });
    const result = await adapter.parseFileWithDiagnostics(filePath);

    expect(result.events).toEqual([]);
    expect(result.skippedRows).toBe(1);
    expect(result.skippedRowReasons).toEqual([{ reason: 'json_parse_error', count: 1 }]);
  });

  it('preserves total-only usage rows', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-total-only-'));
    tempDirs.push(root);

    const chatsDir = path.join(root, 'project', 'chats');
    await mkdir(chatsDir, { recursive: true });
    const filePath = path.join(chatsDir, 'session.jsonl');
    await writeFile(
      filePath,
      JSON.stringify({
        type: 'assistant',
        model: 'qwen3-coder',
        timestamp: '2026-03-01T10:04:00.000Z',
        sessionId: 'qwen-total-only',
        usageMetadata: { totalTokenCount: 33 },
      }),
      'utf8',
    );

    const adapter = new QwenSourceAdapter({ projectsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 33,
    });
  });
});
