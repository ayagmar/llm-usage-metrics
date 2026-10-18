import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionEvent } from '../../../src/domain/session-event.js';
import { CodexSourceAdapter } from '../../../src/sources/codex/index.js';
import { getFileFingerprint } from '../../../src/sources/parse-fingerprint.js';
import { collect } from '../../../src/stream/collect.js';
import { readEvents } from '../../../src/stream/read-events.js';
import { fixturePath } from '../../helpers/fixtures.js';
import { canonicalTmpdir } from '../../helpers/tmp.js';

// A parent with two turns (2,760 tokens on 2026-01-01) and forks of it whose own turn adds
// 540 tokens on 2026-01-02. The copied lines carry the fork's time, as Codex writes them,
// and include a settings event the parent owns, which must not end the copied block.
const FORK_DIR = fixturePath(import.meta.url, '../../fixtures/codex-fork');
const FORK_ID = '019a0000-0000-7000-8000-00000000000b';

const adapter = new CodexSourceAdapter({ dir: FORK_DIR });

async function usageTotalsIn(
  adapterForDir: CodexSourceAdapter,
  filePath: string,
): Promise<{ total: number; byDay: object }> {
  const events = await collect(adapterForDir.read(filePath));
  const byDay: Record<string, number> = {};

  for (const event of events) {
    const day = event.timestamp.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + event.totalTokens;
  }

  return { total: events.reduce((sum, event) => sum + event.totalTokens, 0), byDay };
}

async function usageTotals(fileName: string): Promise<{ total: number; byDay: object }> {
  return usageTotalsIn(adapter, path.join(FORK_DIR, fileName));
}

async function readAll(fileName: string): Promise<SessionEvent[]> {
  return collect(readEvents(adapter, path.join(FORK_DIR, fileName)));
}

describe('Codex forks', () => {
  it('reads the parent on its own day', async () => {
    await expect(usageTotals('parent.jsonl')).resolves.toEqual({
      total: 2760,
      byDay: { '2026-01-01': 2760 },
    });
  });

  // fork-referenced-usage-limit.jsonl: a fork written by Codex 0.153, whose first turn
  // hits the usage limit and logs the parent's running totals before its own turn.
  it.each(['fork-copied.jsonl', 'fork-referenced.jsonl', 'fork-referenced-usage-limit.jsonl'])(
    'counts only the fork’s own turn in %s',
    async (fileName) => {
      await expect(usageTotals(fileName)).resolves.toEqual({
        total: 540,
        byDay: { '2026-01-02': 540 },
      });
    },
  );

  it('yields nothing from the copied lines of a copied fork', async () => {
    const events = await readAll('fork-copied.jsonl');

    expect(events.every((event) => event.sessionId === FORK_ID)).toBe(true);
    expect(events.map((event) => [event.kind, event.timestamp])).toEqual([
      ['session_meta', '2026-01-02T09:00:00.000Z'],
      ['session_meta', '2026-01-02T09:00:01.000Z'],
      ['message', '2026-01-02T09:00:02.000Z'],
      ['tool_call', '2026-01-02T09:00:03.000Z'],
      ['message', '2026-01-02T09:00:05.000Z'],
      ['usage', '2026-01-02T09:00:06.000Z'],
    ]);
  });

  it('reads the same events from a copied fork as from a referenced one', async () => {
    const copied = await readAll('fork-copied.jsonl');
    const referenced = await readAll('fork-referenced.jsonl');

    expect(copied.filter((event) => event.kind !== 'session_meta')).toEqual(
      referenced.filter((event) => event.kind !== 'session_meta'),
    );
  });

  it('keeps counting the copied lines of a fork written without the closing event', async () => {
    // Codex before 0.152 does not mark where the copied lines end.
    await expect(usageTotals('fork-legacy.jsonl')).resolves.toEqual({
      total: 3300,
      byDay: { '2026-01-02': 3300 },
    });

    const events = await readAll('fork-legacy.jsonl');
    expect(events.every((event) => event.sessionId === FORK_ID)).toBe(true);
    expect(events.filter((event) => event.kind === 'usage')).toHaveLength(3);
  });
});

// Forks written by Codex 0.140, which marks no end to the copied lines. The parent has two
// turns (2,760 tokens on 2026-01-01). FULL copies all of it and adds a 540-token turn on
// 2026-01-02, which opens with a token_count that only refreshes the rate limits and so
// repeats the parent's last total. TRUNCATED forks from before the parent's second user
// message: it copies the first turn (1,100 tokens) and adds a 600-token turn on 2026-01-03.
const PARENT_DIR = fixturePath(import.meta.url, '../../fixtures/codex-fork-parent');
const PARENT_FILE = 'rollout-2026-01-01T10-00-00-019a0000-0000-7000-8000-00000000000a.jsonl';
const FULL_FILE = 'rollout-2026-01-02T09-00-00-019a0000-0000-7000-8000-00000000000b.jsonl';
const TRUNCATED_FILE = 'rollout-2026-01-03T08-00-00-019a0000-0000-7000-8000-00000000000c.jsonl';

describe('Codex forks written before the copied block had an end marker', () => {
  const parentAdapter = new CodexSourceAdapter({ dir: PARENT_DIR });
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function copyToTempDir(fileNames: readonly string[]): Promise<string> {
    const dir = await mkdtemp(path.join(canonicalTmpdir(), 'codex-fork-parent-'));
    tempDirs.push(dir);

    for (const fileName of fileNames) {
      await copyFile(path.join(PARENT_DIR, fileName), path.join(dir, fileName));
    }

    return dir;
  }

  it('adds up to the parent plus each fork’s own turn', async () => {
    const files = await parentAdapter.discoverFiles();
    const byDay: Record<string, number> = {};

    for (const filePath of files) {
      for (const [day, tokens] of Object.entries(
        (await usageTotalsIn(parentAdapter, filePath)).byDay,
      )) {
        byDay[day] = (byDay[day] ?? 0) + (tokens as number);
      }
    }

    expect(files).toHaveLength(3);
    expect(byDay).toEqual({ '2026-01-01': 2760, '2026-01-02': 540, '2026-01-03': 600 });
  });

  it('finds the parent without a discovery first, as a parse worker does', async () => {
    await expect(
      usageTotalsIn(new CodexSourceAdapter({ dir: PARENT_DIR }), path.join(PARENT_DIR, FULL_FILE)),
    ).resolves.toEqual({ total: 540, byDay: { '2026-01-02': 540 } });
  });

  it('yields only the fork’s own messages and tool calls', async () => {
    const full = await collect(readEvents(parentAdapter, path.join(PARENT_DIR, FULL_FILE)));
    const truncated = await collect(
      readEvents(parentAdapter, path.join(PARENT_DIR, TRUNCATED_FILE)),
    );

    expect(full.map((event) => [event.kind, event.timestamp])).toEqual([
      ['session_meta', '2026-01-02T09:00:00.000Z'],
      ['session_meta', '2026-01-02T09:00:01.000Z'],
      ['message', '2026-01-02T09:00:02.000Z'],
      ['tool_call', '2026-01-02T09:00:03.000Z'],
      ['message', '2026-01-02T09:00:05.000Z'],
      ['usage', '2026-01-02T09:00:06.000Z'],
    ]);
    expect(truncated.map((event) => [event.kind, event.timestamp])).toEqual([
      ['session_meta', '2026-01-03T08:00:00.000Z'],
      ['session_meta', '2026-01-03T08:00:01.000Z'],
      ['message', '2026-01-03T08:00:02.000Z'],
      ['message', '2026-01-03T08:00:03.000Z'],
      ['usage', '2026-01-03T08:00:04.000Z'],
    ]);
  });

  it('depends on the parent, so a parent edit invalidates the fork', async () => {
    const dir = await copyToTempDir([PARENT_FILE, FULL_FILE]);
    const dirAdapter = new CodexSourceAdapter({ dir });
    const forkPath = path.join(dir, FULL_FILE);

    await expect(dirAdapter.getParseDependencies(forkPath)).resolves.toEqual([
      path.join(dir, PARENT_FILE),
    ]);
    await expect(dirAdapter.getParseDependencies(path.join(dir, PARENT_FILE))).resolves.toEqual([]);

    const before = await getFileFingerprint(dirAdapter, forkPath);
    await appendFile(path.join(dir, PARENT_FILE), '\n');
    const after = await getFileFingerprint(dirAdapter, forkPath);

    expect(after?.dependencies[0]).toEqual(before?.dependencies[0]);
    expect(after).not.toEqual(before);
  });

  it('counts the copied lines again when the parent is missing', async () => {
    const dir = await copyToTempDir([FULL_FILE]);
    const dirAdapter = new CodexSourceAdapter({ dir });
    const forkPath = path.join(dir, FULL_FILE);

    // A path that never exists stands for the parent, so the fork is looked at again.
    const [placeholder] = await dirAdapter.getParseDependencies(forkPath);
    expect((await getFileFingerprint(dirAdapter, forkPath))?.dependencies).toContainEqual({
      path: placeholder,
      exists: false,
    });
    await expect(usageTotalsIn(dirAdapter, forkPath)).resolves.toEqual({
      total: 3300,
      byDay: { '2026-01-02': 3300 },
    });
  });

  type Line = Record<string, unknown>;

  async function readFixtureLines(fileName: string): Promise<Line[]> {
    const text = await readFile(path.join(PARENT_DIR, fileName), 'utf8');
    return text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Line);
  }

  async function writeLines(
    dir: string,
    fileName: string,
    lines: readonly Line[],
  ): Promise<string> {
    const filePath = path.join(dir, fileName);
    await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    return filePath;
  }

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(canonicalTmpdir(), 'codex-fork-parent-'));
    tempDirs.push(dir);
    return dir;
  }

  function usage(input: number, cached: number, output: number, reasoning: number): Line {
    return {
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      reasoning_output_tokens: reasoning,
      total_tokens: input + output,
    };
  }

  // The parent's totals after its first and second turns.
  const FIRST_TOTAL = usage(1000, 200, 100, 40);
  const SECOND_TOTAL = usage(2500, 1200, 260, 90);

  function tokenCount(timestamp: string, total: Line, last: Line, rateLimits?: Line): Line {
    return {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: total, last_token_usage: last, model_context_window: 272000 },
        rate_limits: rateLimits ?? null,
      },
    };
  }

  function message(timestamp: string, role: 'user' | 'assistant', text: string): Line {
    const type = role === 'user' ? 'input_text' : 'output_text';
    return {
      timestamp,
      type: 'response_item',
      payload: { type: 'message', role, content: [{ type, text }] },
    };
  }

  const RATE_LIMITS = { primary: { used_percent: 20, window_minutes: 300 }, secondary: null };

  function insertAfter(lines: Line[], predicate: (line: Line) => boolean, added: Line): Line[] {
    const index = lines.findIndex(predicate);
    expect(index).toBeGreaterThan(-1);
    return [...lines.slice(0, index + 1), added, ...lines.slice(index + 1)];
  }

  function isUserMessage(text: string): (line: Line) => boolean {
    return (line) => JSON.stringify(line.payload).includes(`"text":"${text}"`);
  }

  it('keeps the fork’s own turn when it reaches a total the parent reached later', async () => {
    const dir = await makeTempDir();
    await copyFile(path.join(PARENT_DIR, PARENT_FILE), path.join(dir, PARENT_FILE));
    const lines = await readFixtureLines(TRUNCATED_FILE);
    // The fork's own turn uses as much as the parent's second turn did.
    lines[lines.length - 1] = tokenCount(
      '2026-01-03T08:00:04.000Z',
      SECOND_TOTAL,
      usage(1500, 1000, 160, 50),
    );
    const forkPath = await writeLines(dir, TRUNCATED_FILE, lines);

    await expect(usageTotalsIn(new CodexSourceAdapter({ dir }), forkPath)).resolves.toEqual({
      total: 1660,
      byDay: { '2026-01-03': 1660 },
    });
  });

  it('keeps the fork’s first user message when both branches open with a rate-limit refresh', async () => {
    const dir = await makeTempDir();
    const parentLines = insertAfter(
      await readFixtureLines(PARENT_FILE),
      isUserMessage('Read the first.'),
      tokenCount('2026-01-01T11:00:02.500Z', FIRST_TOTAL, FIRST_TOTAL, RATE_LIMITS),
    );
    await writeLines(dir, PARENT_FILE, parentLines);
    const forkLines = insertAfter(
      await readFixtureLines(TRUNCATED_FILE),
      isUserMessage('Try another way.'),
      tokenCount('2026-01-03T08:00:02.500Z', FIRST_TOTAL, FIRST_TOTAL, RATE_LIMITS),
    );
    const forkPath = await writeLines(dir, TRUNCATED_FILE, forkLines);
    const events = await collect(readEvents(new CodexSourceAdapter({ dir }), forkPath));

    expect(events.filter((event) => event.kind !== 'session_meta')).toMatchObject([
      { kind: 'message', role: 'user', timestamp: '2026-01-03T08:00:02.000Z' },
      { kind: 'message', role: 'assistant', timestamp: '2026-01-03T08:00:03.000Z' },
      { kind: 'usage', totalTokens: 600 },
    ]);
  });

  it('keeps a full fork’s own turn when its parent went on after the fork', async () => {
    const dir = await makeTempDir();
    await writeLines(dir, PARENT_FILE, [
      ...(await readFixtureLines(PARENT_FILE)),
      message('2026-01-02T10:00:00.000Z', 'user', 'Then the third.'),
      tokenCount('2026-01-02T10:00:00.500Z', SECOND_TOTAL, SECOND_TOTAL, RATE_LIMITS),
      message('2026-01-02T10:00:01.000Z', 'assistant', 'Third done.'),
      tokenCount('2026-01-02T10:00:02.000Z', usage(3200, 1300, 320, 100), usage(700, 100, 60, 10)),
    ]);
    await copyFile(path.join(PARENT_DIR, FULL_FILE), path.join(dir, FULL_FILE));
    const events = await collect(
      readEvents(new CodexSourceAdapter({ dir }), path.join(dir, FULL_FILE)),
    );

    expect(events.filter((event) => event.kind !== 'session_meta')).toMatchObject([
      { kind: 'message', role: 'user', timestamp: '2026-01-02T09:00:02.000Z' },
      { kind: 'tool_call', timestamp: '2026-01-02T09:00:03.000Z' },
      { kind: 'message', role: 'assistant', timestamp: '2026-01-02T09:00:05.000Z' },
      { kind: 'usage', totalTokens: 540 },
    ]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails the fork’s read when its parent is there but cannot be read',
    async () => {
      const dir = await copyToTempDir([PARENT_FILE, TRUNCATED_FILE]);
      const parentPath = path.join(dir, PARENT_FILE);
      await chmod(parentPath, 0o000);

      try {
        await expect(
          collect(new CodexSourceAdapter({ dir }).read(path.join(dir, TRUNCATED_FILE))),
        ).rejects.toThrow();
      } finally {
        await chmod(parentPath, 0o600);
      }
    },
  );

  it('finds a parent Codex archived and depends on its new path', async () => {
    const codexHome = await makeTempDir();
    const sessionsDir = path.join(codexHome, 'sessions');
    const archivedDir = path.join(codexHome, 'archived_sessions');
    await mkdir(path.join(sessionsDir, '2026', '01', '02'), { recursive: true });
    await mkdir(archivedDir);
    const forkPath = path.join(sessionsDir, '2026', '01', '02', FULL_FILE);
    await copyFile(path.join(PARENT_DIR, FULL_FILE), forkPath);
    await copyFile(path.join(PARENT_DIR, PARENT_FILE), path.join(archivedDir, PARENT_FILE));
    const dirAdapter = new CodexSourceAdapter({ dir: sessionsDir });

    await expect(dirAdapter.discoverFiles()).resolves.toEqual([forkPath]);
    await expect(dirAdapter.getParseDependencies(forkPath)).resolves.toEqual([
      path.join(archivedDir, PARENT_FILE),
    ]);
    await expect(usageTotalsIn(dirAdapter, forkPath)).resolves.toEqual({
      total: 540,
      byDay: { '2026-01-02': 540 },
    });
  });

  it('keeps finding a parent after Codex moves it to the archive', async () => {
    const codexHome = await makeTempDir();
    const sessionsDir = path.join(codexHome, 'sessions');
    await mkdir(path.join(codexHome, 'archived_sessions'));
    await mkdir(sessionsDir);
    await copyFile(path.join(PARENT_DIR, FULL_FILE), path.join(sessionsDir, FULL_FILE));
    await copyFile(path.join(PARENT_DIR, PARENT_FILE), path.join(sessionsDir, PARENT_FILE));
    const forkPath = path.join(sessionsDir, FULL_FILE);
    const before = await getFileFingerprint(new CodexSourceAdapter({ dir: sessionsDir }), forkPath);

    await rename(
      path.join(sessionsDir, PARENT_FILE),
      path.join(codexHome, 'archived_sessions', PARENT_FILE),
    );
    // A new run builds a new adapter.
    const afterAdapter = new CodexSourceAdapter({ dir: sessionsDir });
    const after = await getFileFingerprint(afterAdapter, forkPath);

    expect(after).not.toEqual(before);
    await expect(usageTotalsIn(afterAdapter, forkPath)).resolves.toEqual({
      total: 540,
      byDay: { '2026-01-02': 540 },
    });
  });

  // A subagent spawned with fork_turns by Codex 0.120 to 0.134 names its parent only in
  // source.subagent.thread_spawn and starts with a copy of the parent's last turn.
  function spawnMeta(timestamp: string, id: string): Line {
    return {
      timestamp,
      type: 'session_meta',
      payload: {
        id,
        timestamp,
        cwd: '/work/demo',
        originator: 'codex_cli_rs',
        cli_version: '0.125.0',
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: '019a0000-0000-7000-8000-00000000000a', depth: 1 },
          },
        },
        model_provider: 'openai',
      },
    };
  }

  const SPAWN_FILE = 'rollout-2026-01-04T08-00-00-019a0000-0000-7000-8000-00000000000d.jsonl';
  const SPAWN_ID = '019a0000-0000-7000-8000-00000000000d';
  const turnContext = (timestamp: string): Line => ({
    timestamp,
    type: 'turn_context',
    payload: { cwd: '/work/demo', approval_policy: 'on-request', model: 'gpt-5-codex' },
  });

  it('counts only the own turn of a subagent spawned with a copy of its parent’s last turn', async () => {
    const dir = await copyToTempDir([PARENT_FILE]);
    const spawnPath = await writeLines(dir, SPAWN_FILE, [
      spawnMeta('2026-01-04T08:00:00.000Z', SPAWN_ID),
      message('2026-01-04T08:00:00.001Z', 'user', 'Read the first.'),
      message('2026-01-04T08:00:00.002Z', 'assistant', 'Done.'),
      tokenCount('2026-01-04T08:00:00.003Z', SECOND_TOTAL, usage(1500, 1000, 160, 50)),
      turnContext('2026-01-04T08:00:01.000Z'),
      message('2026-01-04T08:00:02.000Z', 'user', 'Check it.'),
      message('2026-01-04T08:00:03.000Z', 'assistant', 'Checked.'),
      tokenCount('2026-01-04T08:00:04.000Z', usage(2780, 1400, 280, 95), usage(280, 200, 20, 5)),
    ]);
    const dirAdapter = new CodexSourceAdapter({ dir });

    await expect(usageTotalsIn(dirAdapter, spawnPath)).resolves.toEqual({
      total: 300,
      byDay: { '2026-01-04': 300 },
    });
    expect(
      (await collect(readEvents(dirAdapter, spawnPath))).filter(
        (event) => event.kind === 'message',
      ),
    ).toMatchObject([
      { role: 'user', timestamp: '2026-01-04T08:00:02.000Z' },
      { role: 'assistant', timestamp: '2026-01-04T08:00:03.000Z' },
    ]);
  });

  it('reads a subagent spawned without a copy as before, parent or not', async () => {
    const lines = [
      spawnMeta('2026-01-04T08:00:00.000Z', SPAWN_ID),
      turnContext('2026-01-04T08:00:01.000Z'),
      message('2026-01-04T08:00:02.000Z', 'user', 'Check it.'),
      message('2026-01-04T08:00:03.000Z', 'assistant', 'Checked.'),
      tokenCount('2026-01-04T08:00:04.000Z', usage(280, 200, 20, 5), usage(280, 200, 20, 5)),
    ];
    const withParent = await copyToTempDir([PARENT_FILE]);
    const withoutParent = await makeTempDir();
    const read = async (dir: string): Promise<SessionEvent[]> =>
      collect(
        readEvents(new CodexSourceAdapter({ dir }), await writeLines(dir, SPAWN_FILE, lines)),
      );

    const events = await read(withParent);
    expect(events).toEqual(await read(withoutParent));
    expect(events.filter((event) => event.kind === 'usage')).toMatchObject([{ totalTokens: 300 }]);
  });

  it('confirms a stored fingerprint without reading the fork again', async () => {
    const dir = await copyToTempDir([PARENT_FILE, FULL_FILE]);
    const forkPath = path.join(dir, FULL_FILE);
    const stored = await getFileFingerprint(new CodexSourceAdapter({ dir }), forkPath);
    const warmAdapter = new CodexSourceAdapter({ dir });
    const dependencies = vi.spyOn(warmAdapter, 'getParseDependencies');

    await expect(getFileFingerprint(warmAdapter, forkPath, stored)).resolves.toEqual(stored);
    expect(dependencies).not.toHaveBeenCalled();
  });

  it('looks the parent up again when the stored one has moved', async () => {
    const codexHome = await makeTempDir();
    const sessionsDir = path.join(codexHome, 'sessions');
    await mkdir(path.join(codexHome, 'archived_sessions'));
    await mkdir(sessionsDir);
    await copyFile(path.join(PARENT_DIR, FULL_FILE), path.join(sessionsDir, FULL_FILE));
    await copyFile(path.join(PARENT_DIR, PARENT_FILE), path.join(sessionsDir, PARENT_FILE));
    const forkPath = path.join(sessionsDir, FULL_FILE);
    const stored = await getFileFingerprint(new CodexSourceAdapter({ dir: sessionsDir }), forkPath);
    const archivedPath = path.join(codexHome, 'archived_sessions', PARENT_FILE);
    await rename(path.join(sessionsDir, PARENT_FILE), archivedPath);

    const after = await getFileFingerprint(
      new CodexSourceAdapter({ dir: sessionsDir }),
      forkPath,
      stored,
    );

    expect(after?.dependencies.map((dependency) => dependency.path)).toEqual([
      forkPath,
      archivedPath,
    ]);
  });

  it('keeps the fork’s own turn when it repeats the parent’s next prompt and total', async () => {
    const dir = await makeTempDir();
    await copyFile(path.join(PARENT_DIR, PARENT_FILE), path.join(dir, PARENT_FILE));
    const lines = (await readFixtureLines(TRUNCATED_FILE)).map((line) =>
      isUserMessage('Try another way.')(line)
        ? message(line.timestamp as string, 'user', 'Read the first.')
        : line,
    );
    // The same prompt as the parent's second turn, as many tokens, another answer.
    lines[lines.length - 1] = tokenCount(
      '2026-01-03T08:00:04.000Z',
      SECOND_TOTAL,
      usage(1500, 1000, 160, 50),
    );
    const forkPath = await writeLines(dir, TRUNCATED_FILE, lines);

    await expect(usageTotalsIn(new CodexSourceAdapter({ dir }), forkPath)).resolves.toEqual({
      total: 1660,
      byDay: { '2026-01-03': 1660 },
    });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reads a fork that ends its own copy without its parent, even an unreadable one',
    async () => {
      // A Codex 0.152 fork that ends its copied block with its own closing event.
      const dir = await makeTempDir();
      const parentPath = path.join(dir, PARENT_FILE);
      const forkPath = path.join(dir, FULL_FILE);
      await copyFile(
        fixturePath(import.meta.url, '../../fixtures/codex-fork/parent.jsonl'),
        parentPath,
      );
      await copyFile(path.join(FORK_DIR, 'fork-copied.jsonl'), forkPath);
      const dirAdapter = new CodexSourceAdapter({ dir });
      await chmod(parentPath, 0o000);

      try {
        await expect(dirAdapter.getParseDependencies(forkPath)).resolves.toEqual([]);
        await expect(usageTotalsIn(dirAdapter, forkPath)).resolves.toEqual({
          total: 540,
          byDay: { '2026-01-02': 540 },
        });
      } finally {
        await chmod(parentPath, 0o600);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reads a parent once for all its forks while it stays the same',
    async () => {
      const dir = await copyToTempDir([PARENT_FILE, FULL_FILE, TRUNCATED_FILE]);
      const parentPath = path.join(dir, PARENT_FILE);
      const dirAdapter = new CodexSourceAdapter({ dir });

      await expect(usageTotalsIn(dirAdapter, path.join(dir, FULL_FILE))).resolves.toMatchObject({
        total: 540,
      });
      // chmod keeps the size and mtime: only a parent read before can serve the second fork.
      await chmod(parentPath, 0o000);

      try {
        await expect(
          usageTotalsIn(dirAdapter, path.join(dir, TRUNCATED_FILE)),
        ).resolves.toMatchObject({ total: 600 });
      } finally {
        await chmod(parentPath, 0o600);
      }
    },
  );

  it('does not look for the parent of a subagent from a Codex that spawns no copies', async () => {
    const dir = await copyToTempDir([PARENT_FILE]);
    const meta = spawnMeta('2026-01-04T08:00:00.000Z', SPAWN_ID);
    (meta.payload as Line).cli_version = '0.140.0';
    const spawnPath = await writeLines(dir, SPAWN_FILE, [
      meta,
      message('2026-01-04T08:00:02.000Z', 'user', 'Check it.'),
      tokenCount('2026-01-04T08:00:04.000Z', usage(280, 200, 20, 5), usage(280, 200, 20, 5)),
    ]);

    await expect(new CodexSourceAdapter({ dir }).getParseDependencies(spawnPath)).resolves.toEqual(
      [],
    );
  });

  it('never confirms a fingerprint stored by an earlier Codex parser', async () => {
    const dir = await copyToTempDir([PARENT_FILE, FULL_FILE]);
    const forkPath = path.join(dir, FULL_FILE);
    const dirAdapter = new CodexSourceAdapter({ dir });
    const current = await getFileFingerprint(dirAdapter, forkPath);
    const stored = { dependencies: current?.dependencies ?? [], parserVersion: 'n3.p4' };

    await expect(getFileFingerprint(dirAdapter, forkPath, stored)).resolves.toEqual(current);
  });
});
