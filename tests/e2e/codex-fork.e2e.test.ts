import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

const FORK_FIXTURES = path.resolve('packages/core/tests/fixtures/codex-fork');
// Forks written by Codex 0.140, named as Codex names rollouts so the parent is found by id.
const LEGACY_FORK_FIXTURES = path.resolve('packages/core/tests/fixtures/codex-fork-parent');

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function dailyTotals(
  fixtureNames: readonly string[],
  fixturesDir: string = FORK_FIXTURES,
): Promise<Record<string, number>> {
  const rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'codex-fork-'));
  tempDirs.push(rootDir);
  vi.stubEnv('HOME', rootDir);
  vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
  vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(rootDir, 'events.db'));

  const codexDir = path.join(rootDir, 'sessions');
  await mkdir(codexDir, { recursive: true });

  for (const name of fixtureNames) {
    await copyFile(path.join(fixturesDir, name), path.join(codexDir, name));
  }

  const result = await buildUsageData('daily', {
    all: true,
    source: 'codex',
    codexDir,
    timezone: 'UTC',
    pricingOffline: true,
  });
  const totals: Record<string, number> = {};

  for (const row of result.rows) {
    if (row.rowType === 'grand_total') {
      totals.all = row.totalTokens;
    } else {
      totals[row.periodKey] = row.totalTokens;
    }
  }

  return totals;
}

describe('daily over a Codex parent and its fork', () => {
  it('counts the parent once and the fork for its own turn only', async () => {
    const parent = await dailyTotals(['parent.jsonl']);
    const both = await dailyTotals(['parent.jsonl', 'fork-copied.jsonl']);

    expect(parent).toEqual({ '2026-01-01': 2760, all: 2760 });
    expect(both).toEqual({ '2026-01-01': 2760, '2026-01-02': 540, all: 3300 });
  });

  it('counts a fork written before Codex 0.152 for its own turns only', async () => {
    const parent = 'rollout-2026-01-01T10-00-00-019a0000-0000-7000-8000-00000000000a.jsonl';
    const fork = 'rollout-2026-01-02T09-00-00-019a0000-0000-7000-8000-00000000000b.jsonl';
    const truncated = 'rollout-2026-01-03T08-00-00-019a0000-0000-7000-8000-00000000000c.jsonl';

    await expect(dailyTotals([parent, fork, truncated], LEGACY_FORK_FIXTURES)).resolves.toEqual({
      '2026-01-01': 2760,
      '2026-01-02': 540,
      '2026-01-03': 600,
      all: 3900,
    });
  });

  const PARENT = 'rollout-2026-01-01T10-00-00-019a0000-0000-7000-8000-00000000000a.jsonl';
  const FORK = 'rollout-2026-01-02T09-00-00-019a0000-0000-7000-8000-00000000000b.jsonl';

  /** A Codex home in a temp HOME with the event store on, and a daily run over a directory. */
  async function createCodexHome(): Promise<{
    codexHome: string;
    sessionsDir: string;
    place: (name: string, dir: string) => Promise<string>;
    totals: (codexDir: string) => Promise<Record<string, number>>;
  }> {
    const rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'codex-fork-'));
    tempDirs.push(rootDir);
    vi.stubEnv('HOME', rootDir);
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(rootDir, 'events.db'));
    const codexHome = path.join(rootDir, '.codex');
    const sessionsDir = path.join(codexHome, 'sessions');
    await mkdir(path.join(codexHome, 'archived_sessions'), { recursive: true });

    return {
      codexHome,
      sessionsDir,
      place: async (name, dir) => {
        await mkdir(dir, { recursive: true });
        await copyFile(path.join(LEGACY_FORK_FIXTURES, name), path.join(dir, name));
        return path.join(dir, name);
      },
      totals: async (codexDir) => {
        const result = await buildUsageData('daily', {
          all: true,
          source: 'codex',
          codexDir,
          timezone: 'UTC',
          pricingOffline: true,
        });
        return Object.fromEntries(
          result.rows.map((row) => [
            row.rowType === 'grand_total' ? 'all' : row.periodKey,
            row.totalTokens,
          ]),
        );
      },
    };
  }

  it('keeps counting an old fork once after Codex archives its parent', async () => {
    const { codexHome, sessionsDir, place, totals } = await createCodexHome();
    const dayDir = path.join(sessionsDir, '2026', '01', '01');
    const parentPath = await place(PARENT, dayDir);
    await place(FORK, dayDir);

    await expect(totals(sessionsDir)).resolves.toEqual({
      '2026-01-01': 2760,
      '2026-01-02': 540,
      all: 3300,
    });
    await rename(parentPath, path.join(codexHome, 'archived_sessions', PARENT));
    // The parent left the sessions directory; the fork still counts only its own turn.
    await expect(totals(sessionsDir)).resolves.toMatchObject({ '2026-01-02': 540 });
  });

  it('finds the parent on a normal run after a run over a directory without it', async () => {
    const { sessionsDir, place, totals } = await createCodexHome();
    await place(PARENT, path.join(sessionsDir, '2026', '01', '01'));
    const forkDir = path.join(sessionsDir, '2026', '01', '02');
    await place(FORK, forkDir);

    // Only the fork's day: its parent is out of reach, so the copy counts.
    await expect(totals(forkDir)).resolves.toEqual({ '2026-01-02': 3300, all: 3300 });
    await expect(totals(sessionsDir)).resolves.toEqual({
      '2026-01-01': 2760,
      '2026-01-02': 540,
      all: 3300,
    });
  });

  it.each(['sessions', 'archived_sessions'])(
    'finds a parent put back into %s after the fork was read without it',
    async (parentDirName) => {
      const { codexHome, sessionsDir, place, totals } = await createCodexHome();
      await place(FORK, path.join(sessionsDir, '2026', '01', '02'));

      await expect(totals(sessionsDir)).resolves.toEqual({ '2026-01-02': 3300, all: 3300 });
      await place(PARENT, path.join(codexHome, parentDirName));
      await expect(totals(sessionsDir)).resolves.toMatchObject({ '2026-01-02': 540 });
    },
  );
});
