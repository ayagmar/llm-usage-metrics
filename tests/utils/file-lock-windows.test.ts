import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireFileLock } from '../../src/utils/file-lock.js';

const fsHooks = vi.hoisted(() => ({
  refuseOpen: undefined as ((filePath: string) => boolean) | undefined,
  refuseRename: false,
  failRemoveOf: undefined as ((filePath: string) => boolean) | undefined,
}));

function refusal(): NodeJS.ErrnoException {
  return Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
}

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');

  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (fsHooks.refuseOpen?.(String(args[0]))) {
        throw refusal();
      }

      return actual.open(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsHooks.refuseRename) {
        throw refusal();
      }

      return actual.rename(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (fsHooks.failRemoveOf?.(String(args[0]))) {
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      }

      return actual.rm(...args);
    },
  };
});

const realPlatform = process.platform;
let rootDir: string;
let lockPath: string;

beforeEach(async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'file-lock-windows-'));
  lockPath = path.join(rootDir, 'state.lock');
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  fsHooks.refuseOpen = undefined;
  fsHooks.refuseRename = false;
  fsHooks.failRemoveOf = undefined;
  await rm(rootDir, { recursive: true, force: true });
});

describe('acquireFileLock when Windows refuses a create', () => {
  it('is busy while the lock is being deleted and the directory is writable', async () => {
    fsHooks.refuseOpen = (filePath) => filePath === lockPath;

    await expect(acquireFileLock(lockPath, { waitMs: 0, retryMs: 1 })).resolves.toMatchObject({
      status: 'busy',
      cause: { code: 'EPERM' },
    });
    await expect(readdir(rootDir)).resolves.toEqual([]);
  });

  it('is unavailable at once when the directory cannot be written', async () => {
    fsHooks.refuseOpen = () => true;

    await expect(acquireFileLock(lockPath, { waitMs: 60_000, retryMs: 1 })).resolves.toMatchObject({
      status: 'unavailable',
      error: { code: 'EPERM' },
    });
  });

  it('stays busy when the check file cannot be removed', async () => {
    fsHooks.refuseOpen = (filePath) => filePath === lockPath;
    fsHooks.failRemoveOf = (filePath) => filePath !== rootDir;

    await expect(acquireFileLock(lockPath, { waitMs: 0, retryMs: 1 })).resolves.toMatchObject({
      status: 'busy',
    });
    fsHooks.failRemoveOf = undefined;
  });

  it('is busy, and stops, when a stale lock cannot be moved', async () => {
    await writeFile(lockPath, '');
    await utimes(lockPath, new Date(0), new Date(0));
    fsHooks.refuseRename = true;

    await expect(
      acquireFileLock(lockPath, { waitMs: 0, retryMs: 1, staleAfterMs: 1_000 }),
    ).resolves.toMatchObject({ status: 'busy' });
  });

  it('is unavailable when a stale lock cannot be moved and the directory cannot be written', async () => {
    await writeFile(lockPath, '');
    await utimes(lockPath, new Date(0), new Date(0));
    fsHooks.refuseRename = true;
    fsHooks.refuseOpen = (filePath) => filePath !== lockPath;

    await expect(
      acquireFileLock(lockPath, { waitMs: 0, retryMs: 1, staleAfterMs: 1_000 }),
    ).resolves.toMatchObject({ status: 'unavailable', error: { code: 'EPERM' } });
  });
});
