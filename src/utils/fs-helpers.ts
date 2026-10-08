import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { access, constants, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  let current = path.resolve(directoryPath);

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
