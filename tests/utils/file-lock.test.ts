import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireFileLock, type FileLockOptions } from '../../src/utils/file-lock.js';
import { mulberry32, pick, randomInt, type Random } from '../helpers/seeded-random.js';

const STATUSLINE_STYLE = { retryMs: 1, staleAfterMs: 120_000, directoryMode: 0o700 };
const CONFIG_STYLE = { retryMs: 1 };

let rootDir: string;
let lockPath: string;

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'file-lock-'));
  lockPath = path.join(rootDir, 'state.lock');
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function jitter(random: Random): Promise<void> {
  await sleep(randomInt(random, 3));
}

/** Runs generated acquirers against one lock; fails if two ever hold it together. */
async function runAcquirers(
  random: Random,
  count: number,
  style: Omit<FileLockOptions, 'waitMs'>,
): Promise<void> {
  let holders = 0;
  const plans = Array.from({ length: count }, () => pick(random, [0, 2, 40]));

  await Promise.all(
    plans.map(async (waitMs) => {
      await jitter(random);
      const lock = await acquireFileLock(lockPath, { ...style, waitMs });

      expect(lock.status).not.toBe('unavailable');

      if (lock.status === 'held') {
        holders += 1;
        expect(holders).toBe(1);
        await jitter(random);
        holders -= 1;
        await lock.release();
      }
    }),
  );
}

describe('acquireFileLock', () => {
  it.each([
    ['token-owned', STATUSLINE_STYLE],
    ['plain', CONFIG_STYLE],
  ])('lets at most one %s acquirer hold the lock at a time', async (_label, style) => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = mulberry32(seed);

      await runAcquirers(random, 2 + randomInt(random, 7), style);
      expect(await readdir(rootDir), `seed ${seed}`).toEqual([]);
    }
  });

  it('never takes over a lock without staleAfterMs, however old', async () => {
    const exited = spawnSync(process.execPath, ['-e', '']);
    await writeFile(lockPath, String(exited.pid));
    const longAgo = new Date(Date.now() - 600_000);
    await utimes(lockPath, longAgo, longAgo);

    await expect(acquireFileLock(lockPath, { ...CONFIG_STYLE, waitMs: 5 })).resolves.toMatchObject({
      status: 'busy',
      cause: { code: 'EEXIST' },
    });
    await expect(readdir(rootDir)).resolves.toEqual(['state.lock']);
  });

  it('removes a lock without staleAfterMs on release, whatever it now holds', async () => {
    const lock = await acquireFileLock(lockPath, { ...CONFIG_STYLE, waitMs: 0 });
    await writeFile(lockPath, 'changed');

    expect(lock.status).toBe('held');
    await (lock.status === 'held' ? lock.release() : undefined);
    await expect(readdir(rootDir)).resolves.toEqual([]);
  });

  // chmod does not restrict Windows, or root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unwritable directory as unavailable for either policy',
    async () => {
      await chmod(rootDir, 0o500);

      try {
        for (const style of [STATUSLINE_STYLE, CONFIG_STYLE]) {
          await expect(acquireFileLock(lockPath, { ...style, waitMs: 0 })).resolves.toMatchObject({
            status: 'unavailable',
            error: { code: 'EACCES' },
          });
        }
      } finally {
        await chmod(rootDir, 0o700);
      }
    },
  );
});
