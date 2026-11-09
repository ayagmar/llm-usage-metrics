import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { hasErrorCode } from '@ayagmar/agent-sessions/internal';

export type FileLockOptions = {
  /** How long to retry a held lock before reporting it busy; 0 tries once. */
  waitMs: number;
  retryMs: number;
  /**
   * Set: the lock holds an owner token, one older than this or whose process has exited is
   * taken over, and release removes only this owner's lock. Unset: the lock is empty, is
   * never taken over, and release always removes it.
   */
  staleAfterMs?: number;
  /** The new lock file's mode; the platform default when unset. */
  fileMode?: number;
  /** Creates the lock's directory with this mode; unset, the directory must exist. */
  directoryMode?: number;
};

export type FileLockAcquisition =
  | { status: 'held'; release: () => Promise<void> }
  /** Another holder still has the lock after the wait; `cause` is the last failed create. */
  | { status: 'busy'; cause: unknown }
  /** The lock could not be created at all, as in an unwritable directory. */
  | { status: 'unavailable'; error: unknown };

function isRunningProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return hasErrorCode(error, 'EPERM');
  }
}

/** A lock file's content and modification time, which together tell one lock from the next. */
type LockState = { content: string; mtimeMs: number };

async function readLock(lockPath: string): Promise<LockState | undefined> {
  try {
    const [content, stats] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    return { content, mtimeMs: stats.mtimeMs };
  } catch {
    // Released while we looked: the next attempt takes it.
    return undefined;
  }
}

function isStaleLock(lock: LockState, staleAfterMs: number, now: number): boolean {
  const pid = Number.parseInt(lock.content, 10);

  return (
    now - lock.mtimeMs > staleAfterMs ||
    (Number.isInteger(pid) && pid > 0 && !isRunningProcess(pid))
  );
}

/**
 * Removes a stale lock if it is still the one read as `expected`. The lock is first renamed
 * to a name only this call uses, so of several acquirers reclaiming one lock only one gets
 * it. One that got a newer lock than the one it read puts it back, so no acquirer removes a
 * lock it does not own. Content and mtime both identify the lock: an empty lock left by a
 * crash reads the same as one just created and not yet written. With three or more
 * acquirers reclaiming at once, the put-back can replace a lock taken meanwhile: both
 * holders then proceed, as they would with no lock. False when the lock could not be moved
 * because another acquirer is at it; the caller then waits as for a held lock.
 */
async function reclaimStaleLock(lockPath: string, expected: LockState): Promise<boolean> {
  const claimPath = `${lockPath}.${randomUUID()}`;

  try {
    await rename(lockPath, claimPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return true;
    }

    if (mayBeContended(error)) {
      return false;
    }

    throw error;
  }

  const claimed = await readLock(claimPath);

  if (claimed?.content === expected.content && claimed.mtimeMs === expected.mtimeMs) {
    await rm(claimPath, { force: true });
  } else {
    await rename(claimPath, lockPath);
  }

  return true;
}

/**
 * Whether a failed create may only mean another acquirer is at the lock. Windows refuses to
 * create a file that a release is still deleting, with EPERM or EACCES instead of EEXIST.
 */
function mayBeContended(error: unknown): boolean {
  return (
    hasErrorCode(error, 'EEXIST') ||
    (process.platform === 'win32' &&
      (hasErrorCode(error, 'EPERM') || hasErrorCode(error, 'EACCES')))
  );
}

/**
 * Tells a Windows refusal caused by a lock being deleted, which is contention, from a directory
 * that really cannot be written, by creating and removing a file of this call's own.
 */
async function canCreateFilesBeside(lockPath: string): Promise<boolean> {
  const probePath = `${lockPath}.${randomUUID()}`;

  try {
    await (await open(probePath, 'wx')).close();
  } catch {
    return false;
  }

  // The create already answered; a scanner holding the new file must not change that.
  await rm(probePath, { force: true }).catch(() => undefined);
  return true;
}

async function createLockFile(lockPath: string, content: string, mode?: number): Promise<void> {
  const handle = await open(lockPath, 'wx', mode);

  try {
    await handle.writeFile(content);
  } catch (error) {
    // An empty lock names no process, so it would block others until it went stale.
    await rm(lockPath, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}

async function removeOwnLock(lockPath: string, token: string): Promise<void> {
  // A lock taken over after it went stale is the new holder's to remove. Never renamed:
  // that would leave the path free for a third acquirer while the new holder has it.
  if ((await readFile(lockPath, 'utf8').catch(() => undefined)) === token) {
    await rm(lockPath, { force: true });
  }
}

/** Takes the lock at `lockPath`, reporting a failure to do so instead of throwing. */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions,
): Promise<FileLockAcquisition> {
  const { waitMs, retryMs, staleAfterMs, fileMode, directoryMode } = options;
  // The pid tells others whether the holder still runs; the UUID makes the lock this
  // acquirer's alone, also against another acquirer in the same process.
  const token = staleAfterMs === undefined ? '' : `${String(process.pid)} ${randomUUID()}`;
  const release =
    staleAfterMs === undefined
      ? () => rm(lockPath, { force: true })
      : () => removeOwnLock(lockPath, token);
  const deadline = Date.now() + waitMs;

  try {
    if (directoryMode !== undefined) {
      await mkdir(path.dirname(lockPath), { recursive: true, mode: directoryMode });
    }

    for (;;) {
      let cause: unknown;

      try {
        await createLockFile(lockPath, token, fileMode);
        return { status: 'held', release };
      } catch (error) {
        if (
          !mayBeContended(error) ||
          (!hasErrorCode(error, 'EEXIST') && !(await canCreateFilesBeside(lockPath)))
        ) {
          throw error;
        }

        cause = error;
      }

      const lock = staleAfterMs === undefined ? undefined : await readLock(lockPath);

      if (
        lock &&
        staleAfterMs !== undefined &&
        isStaleLock(lock, staleAfterMs, Date.now()) &&
        (await reclaimStaleLock(lockPath, lock))
      ) {
        continue;
      }

      if (Date.now() >= deadline) {
        return { status: 'busy', cause };
      }

      await sleep(retryMs);
    }
  } catch (error) {
    return { status: 'unavailable', error };
  }
}
