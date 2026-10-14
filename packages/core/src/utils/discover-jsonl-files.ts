import { discoverFiles } from './discover-files.js';

/**
 * Recursively discover .jsonl files in a directory.
 * Returns empty array if rootDir doesn't exist.
 * Skips permission errors in subdirectories (EACCES/EPERM).
 */
export async function discoverJsonlFiles(rootDir: string): Promise<string[]> {
  return discoverFiles(rootDir, { extension: '.jsonl' });
}
