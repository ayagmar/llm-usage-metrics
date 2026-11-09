import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { access, constants, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { hasErrorCode } from './error-code.js';

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function pathReadable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function pathIsDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export async function pathIsFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function pathStat(filePath: string): Promise<Stats | undefined> {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

/**
 * `mkdir -p` that always settles. Node's `mkdir(..., { recursive: true })` never
 * resolves for a path under /proc, where mkdir fails with ENOENT although the
 * parent exists, so a configured path there would hang the CLI at full CPU.
 * This walks up to the nearest existing directory, then creates each missing
 * level once and lets the first failure propagate.
 */
export async function ensureDirectory(directoryPath: string, mode?: number): Promise<void> {
  const missing: string[] = [];
  // The path is walked as given, not resolved: `link/../dir` must climb from the
  // symlink's target, as the later file operation on the same path will.
  let current = directoryPath;

  while (!(await pathIsDirectory(current))) {
    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }

    missing.push(current);
    current = parent;
  }

  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory, { mode });
    } catch (error) {
      // Another process may have created it meanwhile; anything else is a real failure.
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }

      if (!(await pathIsDirectory(directory))) {
        throw error;
      }
    }
  }
}

/**
 * Reads a UTF-8 file, refusing anything but a regular file (or a symlink to one).
 * Opening a FIFO with no writer blocks forever, so a user-supplied path that
 * points at one would hang the CLI. A missing file still rejects with ENOENT.
 */
export async function readRegularTextFile(filePath: string): Promise<string> {
  if (!(await stat(filePath)).isFile()) {
    throw new Error(`${filePath} is not a regular file`);
  }

  return readFile(filePath, 'utf8');
}

const RENAME_RETRY_DELAYS_MS = [20, 40, 80, 160, 320, 640];

/**
 * Windows refuses to replace a file while another process holds it or the new temp file
 * open (a reader of the same file, an antivirus scan), with EPERM, EACCES or EBUSY until
 * that handle closes. Those refusals last milliseconds, so retry them for about a second.
 * Elsewhere these codes almost never come from a rename within one directory; a lasting
 * one is only reported a second later.
 */
async function renameReplacing(tempPath: string, filePath: string): Promise<void> {
  for (const retryDelayMs of RENAME_RETRY_DELAYS_MS) {
    try {
      await rename(tempPath, filePath);
      return;
    } catch (error) {
      if (!hasErrorCode(error, 'EPERM', 'EACCES', 'EBUSY')) {
        throw error;
      }
    }

    await delay(retryDelayMs);
  }

  await rename(tempPath, filePath);
}

/**
 * Writes through a temp file and a rename, so a concurrent reader sees either
 * the old file or the complete new one, never a truncated write.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  mode?: number,
): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    await writeFile(tempPath, content, { encoding: 'utf8', mode });
    await renameReplacing(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
