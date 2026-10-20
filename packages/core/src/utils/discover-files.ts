import { readdir, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { asRecord } from './as-record.js';
import { compareByCodePoint } from './compare-by-code-point.js';

export type DiscoverFilesOptions = {
  /** File extension, or extensions, to match (e.g., '.json', '.settings.json'). Case-insensitive. */
  extension: string | readonly string[];
  /** Whether to recurse into subdirectories. Default: true */
  recursive?: boolean;
  /** Skip permission errors (EACCES/EPERM) instead of throwing. Default: true */
  allowPermissionSkip?: boolean;
  /** Sort files by path for deterministic ordering. Default: true */
  sort?: boolean;
};

const UNRESOLVABLE_SYMLINK_ERROR_CODES = new Set(['ENOENT', 'ELOOP', 'ENOTDIR', 'ENAMETOOLONG']);

function getNodeErrorCode(error: unknown): string | undefined {
  const record = asRecord(error);
  return typeof record?.code === 'string' ? record.code : undefined;
}

function isSkippableDirectoryReadError(error: unknown): boolean {
  const code = getNodeErrorCode(error);
  return code === 'EACCES' || code === 'EPERM';
}

type ResolvedDiscoverFilesOptions = Required<Omit<DiscoverFilesOptions, 'extension'>> & {
  /** Lowercased. */
  extensions: readonly string[];
};

function matchesExtension(fileName: string, extensions: readonly string[]): boolean {
  const lowerFileName = fileName.toLowerCase();
  return extensions.some((extension) => lowerFileName.endsWith(extension));
}

function normalizeExtension(extension: string): string {
  const normalized = extension.trim();

  if (!normalized) {
    throw new Error('discoverFiles extension must be a non-empty string');
  }

  if (!normalized.startsWith('.')) {
    throw new Error('discoverFiles extension must start with "."');
  }

  return normalized.toLowerCase();
}

async function walkDirectory(
  rootDir: string,
  acc: string[],
  options: ResolvedDiscoverFilesOptions,
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
          (matchesExtension(entry.name, options.extensions) ||
            matchesExtension(path.basename(resolvedEntryPath), options.extensions))
        ) {
          acc.push(entryPath);
        }
      } catch (error) {
        // A dangling or looping link is one bad entry, not a reason to fail the whole source.
        if (UNRESOLVABLE_SYMLINK_ERROR_CODES.has(getNodeErrorCode(error) ?? '')) {
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

    if (entry.isFile() && matchesExtension(entry.name, options.extensions)) {
      acc.push(entryPath);
    }
  }
}

async function toCanonicalFiles(
  files: readonly string[],
  options: ResolvedDiscoverFilesOptions,
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
 * Recursively discover files matching any of the given extensions, in one walk.
 * Returns empty array if rootDir doesn't exist.
 * Skips permission errors by default.
 */
export async function discoverFiles(
  rootDir: string,
  options: DiscoverFilesOptions,
): Promise<string[]> {
  const files: string[] = [];
  const extensions =
    typeof options.extension === 'string' ? [options.extension] : options.extension;

  if (extensions.length === 0) {
    throw new Error('discoverFiles needs at least one extension');
  }

  const resolvedOptions: ResolvedDiscoverFilesOptions = {
    extensions: extensions.map(normalizeExtension),
    recursive: options.recursive ?? true,
    allowPermissionSkip: options.allowPermissionSkip ?? true,
    sort: options.sort ?? true,
  };

  await walkDirectory(rootDir, files, resolvedOptions, new Set());

  return toCanonicalFiles(files, resolvedOptions);
}
