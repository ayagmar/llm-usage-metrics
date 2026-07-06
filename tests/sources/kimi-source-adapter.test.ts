import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getDefaultKimiSessionDirs,
  KimiSourceAdapter,
} from '../../src/sources/kimi/kimi-source-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('KimiSourceAdapter', () => {
  it('exposes stable source id and default session directories', () => {
    const adapter = new KimiSourceAdapter();
    const defaultDirs = getDefaultKimiSessionDirs();

    expect(adapter.id).toBe('kimi');
    expect(defaultDirs).toEqual([
      path.join(os.homedir(), '.kimi', 'sessions'),
      path.join(os.homedir(), '.kimi-code', 'sessions'),
    ]);
  });

  it('discovers wire.jsonl files across default roots in deterministic order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kimi-default-roots-'));
    tempDirs.push(root);

    const cliRoot = path.join(root, 'a-cli');
    const codeRoot = path.join(root, 'b-code');
    const missingRoot = path.join(root, 'missing');
    const cliFile = path.join(cliRoot, 'group-a', 'session-a', 'wire.jsonl');
    const codeFile = path.join(
      codeRoot,
      'workspace-a',
      'session-code',
      'agents',
      'agent-a',
      'wire.jsonl',
    );
    const ignoredFile = path.join(cliRoot, 'group-a', 'session-a', 'other.jsonl');
    await mkdir(path.dirname(cliFile), { recursive: true });
    await mkdir(path.dirname(codeFile), { recursive: true });
    await writeFile(cliFile, '{}\n', 'utf8');
    await writeFile(codeFile, '{}\n', 'utf8');
    await writeFile(ignoredFile, '{}\n', 'utf8');

    const adapter = new KimiSourceAdapter({ defaultRootDirs: [codeRoot, cliRoot, missingRoot] });

    await expect(adapter.discoverFiles()).resolves.toEqual([
      await realpath(cliFile),
      await realpath(codeFile),
    ]);
  });

  it('scans only the explicit directory and validates required directory overrides', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kimi-explicit-root-'));
    tempDirs.push(root);

    const cliRoot = path.join(root, 'cli');
    const codeRoot = path.join(root, 'code');
    const cliFile = path.join(cliRoot, 'group-a', 'session-a', 'wire.jsonl');
    const codeFile = path.join(
      codeRoot,
      'workspace-a',
      'session-code',
      'agents',
      'agent-a',
      'wire.jsonl',
    );
    await mkdir(path.dirname(cliFile), { recursive: true });
    await mkdir(path.dirname(codeFile), { recursive: true });
    await writeFile(cliFile, '{}\n', 'utf8');
    await writeFile(codeFile, '{}\n', 'utf8');

    const adapter = new KimiSourceAdapter({
      kimiDir: cliRoot,
      defaultRootDirs: [cliRoot, codeRoot],
    });

    await expect(adapter.discoverFiles()).resolves.toEqual([await realpath(cliFile)]);

    const blankAdapter = new KimiSourceAdapter({ kimiDir: '   ', requireKimiDir: true });
    await expect(blankAdapter.discoverFiles()).rejects.toThrow(
      'Kimi sessions directory must be a non-empty path',
    );

    const missingPath = path.join(os.tmpdir(), `missing-kimi-${Date.now()}`);
    const missingAdapter = new KimiSourceAdapter({
      kimiDir: missingPath,
      requireKimiDir: true,
    });
    await expect(missingAdapter.discoverFiles()).rejects.toThrow(
      'Kimi sessions directory is missing or unreadable',
    );

    const filePath = path.join(root, 'not-a-dir.jsonl');
    await writeFile(filePath, '{}\n', 'utf8');
    const fileAdapter = new KimiSourceAdapter({ kimiDir: filePath, requireKimiDir: true });
    await expect(fileAdapter.discoverFiles()).rejects.toThrow(
      `Kimi sessions directory is not a directory: ${filePath}`,
    );
  });

  it('deduplicates progressive CLI StatusUpdate rows by largest total tokens', async () => {
    const fixturePath = path.resolve('tests/fixtures/kimi/cli/group-a/session-a/wire.jsonl');
    const adapter = new KimiSourceAdapter();

    const result = await adapter.parseFileWithDiagnostics(fixturePath);

    expect(result.events).toHaveLength(3);
    expect(result.events[0]).toMatchObject({
      source: 'kimi',
      sessionId: 'session-a',
      timestamp: '2026-03-02T10:00:02.000Z',
      provider: 'moonshot',
      inputTokens: 35,
      outputTokens: 30,
      reasoningTokens: 0,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 80,
      costMode: 'estimated',
    });
    expect(result.events[0]?.model).toBeUndefined();

    expect(result.events[1]).toMatchObject({
      source: 'kimi',
      sessionId: 'session-a',
      timestamp: '2026-03-02T10:00:03.000Z',
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
    });

    expect(result.events[2]).toMatchObject({
      source: 'kimi',
      sessionId: 'session-a',
      timestamp: '2026-03-02T10:00:04.000Z',
      inputTokens: 30,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 5,
      totalTokens: 60,
    });

    expect(result.skippedRows).toBe(2);
    expect(result.skippedRowReasons).toEqual([
      { reason: 'invalid_timestamp', count: 1 },
      { reason: 'no_token_usage', count: 1 },
    ]);
  });

  it('uses the latest StatusUpdate timestamp when progressive totals tie', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kimi-progressive-tie-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'group-a', 'session-a', 'wire.jsonl');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'event',
          timestamp: 1772445600,
          message: {
            type: 'StatusUpdate',
            payload: {
              message_id: 'message-1',
              token_usage: {
                input_other: 10,
                output: 10,
                input_cache_read: 0,
                input_cache_creation: 0,
                total: 20,
              },
            },
          },
        }),
        JSON.stringify({
          type: 'event',
          timestamp: 1772445602,
          message: {
            type: 'StatusUpdate',
            payload: {
              message_id: 'message-1',
              token_usage: {
                input_other: 8,
                output: 12,
                input_cache_read: 0,
                input_cache_creation: 0,
                total: 20,
              },
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new KimiSourceAdapter({ kimiDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      timestamp: '2026-03-02T10:00:02.000Z',
      inputTokens: 8,
      outputTokens: 12,
      totalTokens: 20,
    });
  });

  it('parses Kimi Code turn-scoped usage records and skips bookkeeping scopes', async () => {
    const fixturePath = path.resolve(
      'tests/fixtures/kimi/code/workspace-a/session-code/agents/agent-a/wire.jsonl',
    );
    const adapter = new KimiSourceAdapter();

    const result = await adapter.parseFileWithDiagnostics(fixturePath);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      source: 'kimi',
      sessionId: 'session-code',
      timestamp: '2026-03-02T10:01:00.000Z',
      provider: 'moonshot',
      model: 'moonshot-v1-128k',
      inputTokens: 11,
      outputTokens: 7,
      reasoningTokens: 0,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      totalTokens: 23,
      costMode: 'estimated',
    });

    expect(result.skippedRows).toBe(2);
    expect(result.skippedRowReasons).toEqual([
      { reason: 'invalid_timestamp', count: 1 },
      { reason: 'no_token_usage', count: 1 },
    ]);
  });
});
