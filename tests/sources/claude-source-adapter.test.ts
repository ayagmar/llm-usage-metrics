import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaudeSourceAdapter,
  getDefaultClaudeProjectsDir,
} from '../../src/sources/claude/claude-source-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function assistantRow(
  overrides: {
    timestamp?: string;
    sessionId?: string;
    cwd?: string;
    messageId?: string;
    model?: string;
    provider?: string;
    usage?: Record<string, unknown>;
    uuid?: string;
  } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: overrides.timestamp ?? '2026-06-23T10:00:00.000Z',
    sessionId: overrides.sessionId ?? 'claude-session-1',
    cwd: overrides.cwd ?? '/tmp/repo',
    uuid: overrides.uuid ?? 'row-uuid-1',
    message: {
      id: overrides.messageId ?? 'msg_1',
      role: 'assistant',
      model: overrides.model ?? 'claude-opus-4-8',
      provider: overrides.provider,
      usage: overrides.usage ?? {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 4,
      },
    },
  });
}

describe('ClaudeSourceAdapter', () => {
  it('exposes stable source id and default directory', () => {
    const adapter = new ClaudeSourceAdapter();

    expect(adapter.id).toBe('claude');
    expect(path.basename(path.dirname(getDefaultClaudeProjectsDir()))).toBe('.claude');
    expect(path.basename(getDefaultClaudeProjectsDir())).toBe('projects');
    expect(path.isAbsolute(getDefaultClaudeProjectsDir())).toBe(true);
  });

  it('discovers project and subagent JSONL files recursively', async () => {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'claude-projects-'));
    tempDirs.push(projectsDir);

    const projectDir = path.join(projectsDir, '-tmp-repo');
    const subagentsDir = path.join(projectDir, 'session-1', 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const sessionFile = path.join(projectDir, 'session-1.jsonl');
    const subagentFile = path.join(subagentsDir, 'agent-a.jsonl');
    await writeFile(sessionFile, '{}\n', 'utf8');
    await writeFile(subagentFile, '{}\n', 'utf8');

    const adapter = new ClaudeSourceAdapter({ projectsDir });

    await expect(adapter.discoverFiles()).resolves.toEqual([
      await realpath(sessionFile),
      await realpath(subagentFile),
    ]);
  });

  it('keeps only the final row per message id and maps token buckets', async () => {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'claude-final-row-'));
    tempDirs.push(projectsDir);
    const filePath = path.join(projectsDir, 'session.jsonl');

    await writeFile(
      filePath,
      [
        assistantRow({
          timestamp: '2026-06-23T10:00:00.000Z',
          messageId: 'msg_streaming',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 1,
          },
          uuid: 'row-1',
        }),
        assistantRow({
          timestamp: '2026-06-23T10:00:01.000Z',
          messageId: 'msg_streaming',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 7,
          },
          uuid: 'row-2',
        }),
        assistantRow({
          timestamp: '2026-06-23T10:00:02.000Z',
          messageId: 'msg_2',
          model: 'google/gemma-4-31b-it-20260402',
          provider: 'Parasail',
          usage: {
            input_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1,
            output_tokens: 5,
          },
          uuid: 'row-3',
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new ClaudeSourceAdapter({ projectsDir });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      source: 'claude',
      sessionId: 'claude-session-1',
      timestamp: '2026-06-23T10:00:01.000Z',
      repoRoot: '/tmp/repo',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      inputTokens: 10,
      cacheWriteTokens: 2,
      cacheReadTokens: 3,
      outputTokens: 7,
      totalTokens: 22,
      costMode: 'estimated',
    });
    expect(events[1]).toMatchObject({
      provider: 'parasail',
      model: 'google/gemma-4-31b-it-20260402',
      inputTokens: 20,
      cacheReadTokens: 1,
      outputTokens: 5,
      totalTokens: 26,
    });
  });

  it('reports skipped synthetic and invalid rows', async () => {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'claude-skipped-'));
    tempDirs.push(projectsDir);
    const filePath = path.join(projectsDir, 'session.jsonl');

    await writeFile(
      filePath,
      [
        assistantRow({ model: '<synthetic>', uuid: 'synthetic-row' }),
        assistantRow({
          timestamp: 'not-a-date',
          messageId: 'msg_invalid_timestamp',
          uuid: 'invalid-timestamp-row',
        }),
        assistantRow({
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
          messageId: 'msg_no_usage',
          uuid: 'no-usage-row',
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new ClaudeSourceAdapter({ projectsDir });
    const result = await adapter.parseFileWithDiagnostics(filePath);

    expect(result.events).toEqual([]);
    expect(result.skippedRows).toBe(3);
    expect(result.skippedRowReasons).toEqual([
      { reason: 'invalid_timestamp', count: 1 },
      { reason: 'no_token_usage', count: 1 },
      { reason: 'synthetic_message', count: 1 },
    ]);
  });

  it('validates explicit directory overrides', async () => {
    const blankAdapter = new ClaudeSourceAdapter({ projectsDir: '   ' });
    await expect(blankAdapter.discoverFiles()).rejects.toThrow(
      'Claude projects directory must be a non-empty path',
    );

    const missingAdapter = new ClaudeSourceAdapter({
      projectsDir: path.join(os.tmpdir(), `missing-claude-${Date.now()}`),
      requireProjectsDir: true,
    });
    await expect(missingAdapter.discoverFiles()).rejects.toThrow(
      'Claude projects directory is missing or unreadable',
    );
  });
});
