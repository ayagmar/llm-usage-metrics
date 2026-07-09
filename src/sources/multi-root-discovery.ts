import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { pathIsDirectory, pathReadable } from '../utils/fs-helpers.js';
import { isBlankText } from './parsing-utils.js';

export type MultiRootDiscoveryOptions = {
  rootDirs: readonly string[];
  requireDir: boolean;
  directoryLabel: string;
  discoverInRoot: (rootDir: string) => Promise<string[]>;
  sortAcrossRoots?: boolean;
};

export function resolveRootDirs(
  overrideDir: string | undefined,
  defaultRootDirs: readonly string[],
): readonly string[] {
  return overrideDir !== undefined ? [overrideDir] : defaultRootDirs;
}

export async function discoverFilesAcrossRoots(
  options: MultiRootDiscoveryOptions,
): Promise<string[]> {
  const discoveredFiles: string[] = [];

  for (const rootDir of options.rootDirs) {
    if (isBlankText(rootDir)) {
      throw new Error(`${options.directoryLabel} must be a non-empty path`);
    }

    const normalizedRootDir = rootDir.trim();

    if (options.requireDir && !(await pathReadable(normalizedRootDir))) {
      throw new Error(`${options.directoryLabel} is missing or unreadable: ${normalizedRootDir}`);
    }

    if (options.requireDir && !(await pathIsDirectory(normalizedRootDir))) {
      throw new Error(`${options.directoryLabel} is not a directory: ${normalizedRootDir}`);
    }

    discoveredFiles.push(...(await options.discoverInRoot(normalizedRootDir)));
  }

  return options.sortAcrossRoots ? discoveredFiles.sort(compareByCodePoint) : discoveredFiles;
}
