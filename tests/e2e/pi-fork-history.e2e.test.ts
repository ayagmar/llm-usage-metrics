import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function usageRow(timestamp: string): string {
  return JSON.stringify({
    type: 'message',
    timestamp,
    message: { role: 'assistant', usage: { input: 10, output: 5, totalTokens: 15 } },
  });
}

async function totalTokens(piDir: string): Promise<number | undefined> {
  const result = await buildUsageData('daily', {
    all: true,
    source: 'pi',
    piDir,
    // A custom directory gets history only on request.
    history: true,
    timezone: 'UTC',
    pricingOffline: true,
  });

  return result.rows.find((row) => row.rowType === 'grand_total')?.totalTokens;
}

// A parent with usage rows at the given times, and forks made at 20:05 that each copy the
// parent's 20:01 row and add their own at 20:06.
async function writeParentAndForks(
  parentRows: string[],
  forkIds: string[] = ['fork-id'],
): Promise<{
  piDir: string;
  parentPath: string;
}> {
  const rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'pi-fork-history-'));
  tempDirs.push(rootDir);
  vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
  vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(rootDir, 'events.db'));

  const piDir = path.join(rootDir, 'sessions');
  const projectDir = path.join(piDir, '--project--');
  const parentPath = path.join(projectDir, '2026-02-12T20-00-00-000Z_parent-id.jsonl');
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    parentPath,
    [
      JSON.stringify({ type: 'session', id: 'parent-id', timestamp: '2026-02-12T20:00:00.000Z' }),
      ...parentRows.map(usageRow),
    ].join('\n'),
  );
  for (const forkId of forkIds) {
    await writeFile(
      path.join(projectDir, `2026-02-12T20-05-00-000Z_${forkId}.jsonl`),
      [
        JSON.stringify({
          type: 'session',
          id: forkId,
          timestamp: '2026-02-12T20:05:00.000Z',
          parentSession: parentPath,
        }),
        usageRow('2026-02-12T20:01:00.000Z'),
        usageRow('2026-02-12T20:06:00.000Z'),
      ].join('\n'),
    );
  }

  return { piDir, parentPath };
}

describe('a pi fork whose parent session is deleted', () => {
  it('counts the copied usage once, from the fork or from history', async () => {
    const { piDir, parentPath } = await writeParentAndForks(['2026-02-12T20:01:00.000Z']);

    const before = await totalTokens(piDir);
    await rm(parentPath);
    const afterDeletion = await totalTokens(piDir);

    expect(before).toBe(30);
    expect(afterDeletion).toBe(30);
  });

  it('counts the copied usage once when the parent kept going after the fork', async () => {
    const { piDir, parentPath } = await writeParentAndForks([
      '2026-02-12T20:01:00.000Z',
      '2026-02-12T20:10:00.000Z',
    ]);

    const before = await totalTokens(piDir);
    await rm(parentPath);
    const afterDeletion = await totalTokens(piDir);

    expect(before).toBe(45);
    expect(afterDeletion).toBe(45);
  });

  it('counts the copied usage once when two forks copy it', async () => {
    const { piDir, parentPath } = await writeParentAndForks(
      ['2026-02-12T20:01:00.000Z'],
      ['fork-a', 'fork-b'],
    );

    const before = await totalTokens(piDir);
    await rm(parentPath);
    const afterDeletion = await totalTokens(piDir);

    expect(before).toBe(45);
    expect(afterDeletion).toBe(45);
  });

  it('keeps a parent entry the forks copied fewer times than the parent holds it', async () => {
    // The parent repeats its 20:01 entry; each fork copied it once.
    const { piDir, parentPath } = await writeParentAndForks(
      ['2026-02-12T20:01:00.000Z', '2026-02-12T20:01:00.000Z', '2026-02-12T20:10:00.000Z'],
      ['fork-a', 'fork-b'],
    );

    const before = await totalTokens(piDir);
    await rm(parentPath);
    const afterDeletion = await totalTokens(piDir);

    expect(before).toBe(75);
    expect(afterDeletion).toBe(75);
  });
});
