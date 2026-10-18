import { pathStat } from '../utils/fs-helpers.js';

/** What was read from a parent file at one version (size and mtime) of it. */
export type ParentVersion<T> = { versionKey: string; value: Promise<T> };

/**
 * What `read` returns for a parent file, read once per version of the file. Only the latest
 * version per path is kept, so a parent that grows does not leave one value per version
 * behind. Undefined when the parent cannot be found.
 */
export async function readParentVersion<T>(
  parentPath: string,
  cache: Map<string, ParentVersion<T>>,
  read: (parentPath: string) => Promise<T>,
): Promise<T | undefined> {
  const parentStats = await pathStat(parentPath);

  if (!parentStats) {
    return undefined;
  }

  const versionKey = `${parentStats.size}\0${parentStats.mtimeMs}`;
  const cached = cache.get(parentPath);

  if (cached?.versionKey === versionKey) {
    return cached.value;
  }

  const value = read(parentPath);
  cache.set(parentPath, { versionKey, value });
  return value;
}
