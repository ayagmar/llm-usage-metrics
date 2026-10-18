import { appendFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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

    await expect(dirAdapter.getParseDependencies(forkPath)).resolves.toEqual([]);
    await expect(usageTotalsIn(dirAdapter, forkPath)).resolves.toEqual({
      total: 3300,
      byDay: { '2026-01-02': 3300 },
    });
  });
});
