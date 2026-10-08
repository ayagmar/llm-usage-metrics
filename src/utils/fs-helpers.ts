import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { access, constants, rename, rm, stat, writeFile } from 'node:fs/promises';

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
