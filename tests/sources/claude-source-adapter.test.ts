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
    requestId?: string;
  } = {},
): string {
  const message: Record<string, unknown> = {
    role: 'assistant',
    model: overrides.model ?? 'claude-opus-4-8',
    provider: overrides.provider,
    usage: overrides.usage ?? {
      input_tokens: 10,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 4,
    },
  };

  if (overrides.messageId !== undefined) {
    message.id = overrides.messageId;
  } else {
    message.id = 'msg_1';
  }

  const row: Record<string, unknown> = {
    type: 'assistant',
    timestamp: overrides.timestamp ?? '2026-06-23T10:00:00.000Z',
    sessionId: overrides.sessionId ?? 'claude-session-1',
    cwd: overrides.cwd ?? '/tmp/repo',
    message,
  };

  if (overrides.uuid !== undefined) {
    row.uuid = overrides.uuid;
  } else {
    row.uuid = 'row-uuid-1';
  }

  if (overrides.requestId !== undefined) {
    row.requestId = overrides.requestId;
  }

  return JSON.stringify(row);
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

  it('scans all default roots and silently skips missing ones', async () => {
    const projectsRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-root-projects-'));
    const transcriptsRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-root-transcripts-'));
    tempDirs.push(projectsRoot, transcriptsRoot);

    const projectFile = path.join(projectsRoot, 'session-a.jsonl');
    const transcriptFile = path.join(transcriptsRoot, 'session-b.jsonl');
    await writeFile(projectFile, assistantRow({ messageId: 'msg_a' }), 'utf8');
    await writeFile(transcriptFile, assistantRow({ messageId: 'msg_b' }), 'utf8');
    const missingRoot = path.join(transcriptsRoot, 'missing');

    const adapter = new ClaudeSourceAdapter({
      defaultRootDirs: [projectsRoot, transcriptsRoot, missingRoot],
    });

    await expect(adapter.discoverFiles()).resolves.toEqual([
      await realpath(projectFile),
      await realpath(transcriptFile),
    ]);
    await expect(adapter.parseFile(projectFile)).resolves.toHaveLength(1);
    await expect(adapter.parseFile(transcriptFile)).resolves.toHaveLength(1);
  });

  it('scans only the explicit directory when a dir override is provided', async () => {
    const projectsRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-explicit-projects-'));
    const transcriptsRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-explicit-transcripts-'));
    tempDirs.push(projectsRoot, transcriptsRoot);

    const projectFile = path.join(projectsRoot, 'session-a.jsonl');
    await writeFile(projectFile, assistantRow({ messageId: 'msg_a' }), 'utf8');
    await writeFile(path.join(transcriptsRoot, 'session-b.jsonl'), assistantRow(), 'utf8');

    const adapter = new ClaudeSourceAdapter({
      projectsDir: projectsRoot,
      defaultRootDirs: [projectsRoot, transcriptsRoot],
    });

    await expect(adapter.discoverFiles()).resolves.toEqual([await realpath(projectFile)]);
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

  it('infers provider roots from model when provider is missing', async () => {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'claude-provider-inference-'));
    tempDirs.push(projectsDir);
    const filePath = path.join(projectsDir, 'session.jsonl');

    await writeFile(
      filePath,
      [
        assistantRow({ messageId: 'msg_claude', model: 'claude-sonnet-4-5' }),
        assistantRow({ messageId: 'msg_gpt', model: 'gpt-5.2' }),
        assistantRow({ messageId: 'msg_gemini', model: 'gemini-3-flash' }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new ClaudeSourceAdapter({ projectsDir });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(3);
    expect(events.map((event) => event.provider)).toEqual(['anthropic', 'openai', 'google']);
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

  it('counts id-less usage rows via a content-based fallback dedup key', async () => {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'claude-idless-'));
    tempDirs.push(projectsDir);
    const filePath = path.join(projectsDir, 'session.jsonl');

    await writeFile(
      filePath,
      [
        // No message.id and no uuid: previously dropped as missing_message_id.
        assistantRow({
          messageId: '',
          uuid: '',
          timestamp: '2026-06-23T10:00:00.000Z',
          usage: { input_tokens: 9, output_tokens: 1 },
        }),
        // Same timestamp + model collapses to the same fallback key, so the
        // second row replaces the first (last-row-wins), not double-counted.
        assistantRow({
          messageId: '',
          uuid: '',
          timestamp: '2026-06-23T10:00:00.000Z',
          usage: { input_tokens: 9, output_tokens: 4 },
        }),
        // Different timestamp -> distinct fallback key -> separate event.
        assistantRow({
          messageId: '',
          uuid: '',
          timestamp: '2026-06-23T11:00:00.000Z',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new ClaudeSourceAdapter({ projectsDir });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      model: 'claude-opus-4-8',
      outputTokens: 4,
      totalTokens: 13,
    });
    expect(events[1]).toMatchObject({
      model: 'claude-sonnet-4-5',
      totalTokens: 7,
    });
  });

  it('still deduplicates streamed rows sharing message id and request id', async () => {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'claude-request-dedup-'));
    tempDirs.push(projectsDir);
    const filePath = path.join(projectsDir, 'session.jsonl');

    await writeFile(
      filePath,
      [
        assistantRow({
          timestamp: '2026-06-23T10:00:00.000Z',
          messageId: 'msg_streamed',
          requestId: 'req_1',
          usage: { input_tokens: 10, output_tokens: 1 },
          uuid: 'row-1',
        }),
        assistantRow({
          timestamp: '2026-06-23T10:00:01.000Z',
          messageId: 'msg_streamed',
          requestId: 'req_1',
          usage: { input_tokens: 10, output_tokens: 6 },
          uuid: 'row-2',
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new ClaudeSourceAdapter({ projectsDir });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outputTokens: 6, totalTokens: 16 });
  });

  it('counts retries with the same message id but different request ids separately', async () => {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'claude-retry-dedup-'));
    tempDirs.push(projectsDir);
    const filePath = path.join(projectsDir, 'session.jsonl');

    await writeFile(
      filePath,
      [
        assistantRow({
          timestamp: '2026-06-23T10:00:00.000Z',
          messageId: 'msg_retried',
          requestId: 'req_1',
          usage: { input_tokens: 10, output_tokens: 1 },
          uuid: 'row-1',
        }),
        assistantRow({
          timestamp: '2026-06-23T10:00:01.000Z',
          messageId: 'msg_retried',
          requestId: 'req_2',
          usage: { input_tokens: 10, output_tokens: 6 },
          uuid: 'row-2',
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new ClaudeSourceAdapter({ projectsDir });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ outputTokens: 1, totalTokens: 11 });
    expect(events[1]).toMatchObject({ outputTokens: 6, totalTokens: 16 });
  });

  it('deduplicates by uuid when message id is absent', async () => {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'claude-uuid-dedup-'));
    tempDirs.push(projectsDir);
    const filePath = path.join(projectsDir, 'session.jsonl');

    await writeFile(
      filePath,
      [
        assistantRow({
          messageId: '',
          uuid: 'row-uuid-shared',
          timestamp: '2026-06-23T10:00:00.000Z',
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
        assistantRow({
          messageId: '',
          uuid: 'row-uuid-shared',
          timestamp: '2026-06-23T10:00:01.000Z',
          usage: { input_tokens: 10, output_tokens: 8 },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new ClaudeSourceAdapter({ projectsDir });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outputTokens: 8, totalTokens: 18 });
  });

  it('reports malformed JSONL lines that pass its byte prefilter', async () => {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'claude-malformed-jsonl-'));
    tempDirs.push(projectsDir);
    const filePath = path.join(projectsDir, 'session.jsonl');

    await writeFile(filePath, '{"type":"assistant","usage":', 'utf8');

    const adapter = new ClaudeSourceAdapter({ projectsDir });
    const diagnostics = await adapter.parseFileWithDiagnostics(filePath);

    expect(diagnostics.events).toEqual([]);
    expect(diagnostics.skippedRows).toBe(1);
    expect(diagnostics.skippedRowReasons).toEqual([{ reason: 'json_parse_error', count: 1 }]);
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
