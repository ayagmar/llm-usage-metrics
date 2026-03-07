import { readdir, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { asRecord } from './as-record.js';
import { compareByCodePoint } from './compare-by-code-point.js';

export type DiscoverFilesOptions = {
  /** File extension to match (e.g., '.json', '.settings.json'). Case-insensitive. */
  extension: string;
  /** Whether to recurse into subdirectories. Default: true */
  recursive?: boolean;
  /** Skip permission errors (EACCES/EPERM) instead of throwing. Default: true */
  allowPermissionSkip?: boolean;
  /** Sort files by path for deterministic ordering. Default: true */
  sort?: boolean;
};

function getNodeErrorCode(error: unknown): string | undefined {
  const record = asRecord(error);
  return typeof record?.code === 'string' ? record.code : undefined;
}

function isSkippableDirectoryReadError(error: unknown): boolean {
  const code = getNodeErrorCode(error);
  return code === 'EACCES' || code === 'EPERM';
}

function matchesExtension(fileName: string, extension: string): boolean {
  const lowerFileName = fileName.toLowerCase();
  const lowerExtension = extension.toLowerCase();
  return lowerFileName.endsWith(lowerExtension);
}

function normalizeExtension(extension: string): string {
  const normalized = extension.trim();

  if (!normalized) {
    throw new Error('discoverFiles extension must be a non-empty string');
  }

  if (!normalized.startsWith('.')) {
    throw new Error('discoverFiles extension must start with "."');
  }

  return normalized;
}

async function walkDirectory(
  rootDir: string,
  acc: string[],
  options: Required<DiscoverFilesOptions>,
  ancestryRealPaths: ReadonlySet<string>,
): Promise<void> {
  let resolvedRootDir: string;

  try {
    resolvedRootDir = await realpath(rootDir);
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') {
      return;
    }

    if (options.allowPermissionSkip && isSkippableDirectoryReadError(error)) {
      return;
    }

    throw error;
  }

  if (ancestryRealPaths.has(resolvedRootDir)) {
    return;
  }

  let entries: Dirent[];

  try {
    entries = await readdir(rootDir, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') {
      return;
    }

    if (options.allowPermissionSkip && isSkippableDirectoryReadError(error)) {
      return;
    }

    throw error;
  }

  const nextAncestryRealPaths = new Set(ancestryRealPaths);
  nextAncestryRealPaths.add(resolvedRootDir);

  if (options.sort) {
    entries.sort((left, right) => compareByCodePoint(left.name, right.name));
  }

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);

    if (entry.isSymbolicLink()) {
      try {
        const entryStats = await stat(entryPath);
        const resolvedEntryPath = await realpath(entryPath);

        if (entryStats.isDirectory() && options.recursive) {
          await walkDirectory(entryPath, acc, options, nextAncestryRealPaths);
          continue;
        }

        if (
          entryStats.isFile() &&
          (matchesExtension(entry.name, options.extension) ||
            matchesExtension(path.basename(resolvedEntryPath), options.extension))
        ) {
          acc.push(entryPath);
        }
      } catch (error) {
        if (getNodeErrorCode(error) === 'ENOENT') {
          continue;
        }

        if (options.allowPermissionSkip && isSkippableDirectoryReadError(error)) {
          continue;
        }

        throw error;
      }

      continue;
    }

    if (entry.isDirectory() && options.recursive) {
      await walkDirectory(entryPath, acc, options, nextAncestryRealPaths);
      continue;
    }

    if (entry.isFile() && matchesExtension(entry.name, options.extension)) {
      acc.push(entryPath);
    }
  }
}

async function toCanonicalFiles(
  files: readonly string[],
  options: Required<DiscoverFilesOptions>,
): Promise<string[]> {
  const canonicalFiles: string[] = [];
  const seenRealPaths = new Set<string>();

  for (const filePath of files) {
    let resolvedFilePath: string;

    try {
      resolvedFilePath = await realpath(filePath);
    } catch (error) {
      if (getNodeErrorCode(error) === 'ENOENT') {
        continue;
      }

      if (options.allowPermissionSkip && isSkippableDirectoryReadError(error)) {
        continue;
      }

      throw error;
    }

    if (seenRealPaths.has(resolvedFilePath)) {
      continue;
    }

    seenRealPaths.add(resolvedFilePath);
    canonicalFiles.push(resolvedFilePath);
  }

  if (options.sort) {
    canonicalFiles.sort(compareByCodePoint);
  }

  return canonicalFiles;
}

/**
 * Recursively discover files matching the given extension.
 * Returns empty array if rootDir doesn't exist.
 * Skips permission errors by default.
 */
export async function discoverFiles(
  rootDir: string,
  options: DiscoverFilesOptions,
): Promise<string[]> {
  const files: string[] = [];
  const resolvedOptions: Required<DiscoverFilesOptions> = {
    extension: normalizeExtension(options.extension),
    recursive: options.recursive ?? true,
    allowPermissionSkip: options.allowPermissionSkip ?? true,
    sort: options.sort ?? true,
  };

  await walkDirectory(rootDir, files, resolvedOptions, new Set());

  return toCanonicalFiles(files, resolvedOptions);
}
