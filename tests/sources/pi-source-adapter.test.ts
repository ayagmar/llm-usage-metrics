import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getDefaultPiSessionsDir,
  PiSourceAdapter,
} from '../../src/sources/pi/pi-source-adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('PiSourceAdapter', () => {
  it('discovers jsonl files recursively in deterministic order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-source-adapter-'));
    tempDirs.push(root);

    const nested = path.join(root, 'nested');
    await mkdir(nested, { recursive: true });

    const first = path.join(root, 'a.jsonl');
    const second = path.join(nested, 'b.jsonl');

    await writeFile(path.join(root, 'ignore.txt'), 'noop', 'utf8');
    await writeFile(second, '{}\n', 'utf8');
    await writeFile(first, '{}\n', 'utf8');

    const adapter = new PiSourceAdapter({ sessionsDir: root });

    await expect(adapter.discoverFiles()).resolves.toEqual([first, second]);
  });

  it('parses usage events without provider filtering by default', async () => {
    const fixturePath = path.resolve('tests/fixtures/pi/session-mixed.jsonl');
    const adapter = new PiSourceAdapter();

    const events = await adapter.parseFile(fixturePath);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      source: 'pi',
      sessionId: 'session-pi-1',
      repoRoot: '/tmp/pi-repo',
      provider: 'openai',
      model: 'gpt-5.3-codex',
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 10,
      cacheWriteTokens: 3,
      totalTokens: 120,
      costUsd: 0.01,
      costMode: 'explicit',
    });

    expect(events[1]).toMatchObject({
      source: 'pi',
      sessionId: 'session-pi-1',
      provider: 'anthropic',
      model: 'claude-3.7-sonnet',
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
      costMode: 'explicit',
    });

    expect(events[2]).toMatchObject({
      source: 'pi',
      sessionId: 'session-pi-1',
      repoRoot: '/tmp/pi-repo',
      provider: 'openai',
      model: 'gpt-4.1',
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      costMode: 'estimated',
    });

    expect(events[2]?.timestamp).toBe('2026-02-12T20:01:00.000Z');
  });

  it('falls back to message.usage when line-level usage is malformed or empty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-source-message-usage-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'pi-message-usage',
          timestamp: '2026-02-12T20:00:00.000Z',
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-02-12T20:01:00.000Z',
          provider: 'openai',
          usage: 'unexpected-string',
          message: {
            usage: {
              input: 4,
              output: 6,
              totalTokens: 10,
            },
          },
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-02-12T20:02:00.000Z',
          provider: 'openai',
          usage: {},
          message: {
            usage: {
              input: 3,
              output: 2,
              totalTokens: 5,
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new PiSourceAdapter({ sessionsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });
    expect(events[1]).toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    });
  });

  it('falls back to message timestamp when line timestamp is malformed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-source-malformed-line-timestamp-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'pi-malformed-line-timestamp',
        }),
        JSON.stringify({
          type: 'message',
          timestamp: 'not-a-date',
          message: {
            timestamp: '2026-02-12T20:01:00.000Z',
          },
          provider: 'openai',
          usage: {
            input: 1,
            output: 2,
            totalTokens: 3,
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new PiSourceAdapter({ sessionsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]?.timestamp).toBe('2026-02-12T20:01:00.000Z');
  });

  it('supports unix-second timestamps in message events', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-source-unix-seconds-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'pi-unix-seconds',
        }),
        JSON.stringify({
          type: 'message',
          timestamp: 1_707_768_000,
          provider: 'openai',
          usage: {
            input: 1,
            output: 2,
            totalTokens: 3,
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new PiSourceAdapter({ sessionsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]?.timestamp).toBe('2024-02-12T20:00:00.000Z');
  });

  it('preserves total-only usage without inventing billable buckets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-source-total-only-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'pi-total-only',
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-02-12T20:01:00.000Z',
          provider: 'openai',
          model: 'gpt-5.2',
          usage: {
            totalTokens: 33,
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new PiSourceAdapter({ sessionsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.2',
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 33,
      costUsd: undefined,
      costMode: 'estimated',
    });
  });

  it('treats millisecond timestamps as milliseconds (without multiplying by 1000)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-source-unix-milliseconds-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'pi-unix-milliseconds',
        }),
        JSON.stringify({
          type: 'message',
          timestamp: 946_684_800_000,
          provider: 'openai',
          usage: {
            input: 1,
            output: 2,
            totalTokens: 3,
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new PiSourceAdapter({ sessionsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]?.timestamp).toBe('2000-01-01T00:00:00.000Z');
  });

  it('ignores out-of-range numeric timestamps instead of crashing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-source-invalid-numeric-ts-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'pi-invalid-numeric-ts',
        }),
        JSON.stringify({
          type: 'message',
          timestamp: Number.MAX_VALUE,
          provider: 'openai',
          usage: {
            input: 1,
            output: 2,
            totalTokens: 3,
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new PiSourceAdapter({ sessionsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toEqual([]);
  });

  it('skips message entries that only carry zero usage and zero cost', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-source-zero-usage-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'pi-zero-usage',
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-02-12T20:01:00.000Z',
          provider: 'openai',
          usage: {
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { total: 0 },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new PiSourceAdapter({ sessionsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toEqual([]);
  });

  it('keeps cost-only usage entries when explicit non-zero cost exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-source-cost-only-'));
    tempDirs.push(root);

    const filePath = path.join(root, 'session.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session',
          id: 'pi-cost-only',
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-02-12T20:01:00.000Z',
          provider: 'openai',
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: { total: 0.42 },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const adapter = new PiSourceAdapter({ sessionsDir: root });
    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      totalTokens: 0,
      costUsd: 0.42,
      costMode: 'explicit',
    });
  });
});

describe('pi source helpers', () => {
  it('returns the default pi sessions path', () => {
    expect(getDefaultPiSessionsDir()).toContain(path.join('.pi', 'agent', 'sessions'));
  });
});
