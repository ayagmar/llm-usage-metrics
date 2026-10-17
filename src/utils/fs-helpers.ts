import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { pathIsDirectory } from '@ayagmar/agent-sessions/internal';

export {
  pathExists,
  pathIsDirectory,
  pathIsFile,
  pathReadable,
  pathStat,
} from '@ayagmar/agent-sessions/internal';
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

/**
 * Writes through a temp file and a rename, so a concurrent reader sees either
 * the old file or the complete new one, never a truncated write.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
