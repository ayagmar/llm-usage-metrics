import { stat } from 'node:fs/promises';

import { USAGE_EVENT_NORMALIZATION_VERSION } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { hasErrorCode } from '../utils/error-code.js';
import type { SourceAdapter } from './source-adapter.js';

/** Version of the normalized event shape; part of every parse cache key. */
export const CORE_EVENT_VERSION = USAGE_EVENT_NORMALIZATION_VERSION;

export type FileDependencyFingerprint = {
  path: string;
  exists: boolean;
  size?: number;
  mtimeMs?: number;
};

export type FileFingerprint = {
  /** Identifies the parser that produced the stored events; a change forces a re-parse. */
  parserVersion?: string;
  dependencies: FileDependencyFingerprint[];
};

async function createFileDependencyFingerprint(
  filePath: string,
  options: { allowMissing: boolean },
): Promise<FileDependencyFingerprint | undefined> {
  try {
    const fileStat = await stat(filePath);

    return {
      path: filePath,
      exists: true,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch (error) {
    if (options.allowMissing && hasErrorCode(error, 'ENOENT')) {
      return {
        path: filePath,
        exists: false,
      };
    }

    return undefined;
  }
}

/**
 * The version string of the events an adapter produces, `n<normalization>.p<parser>`.
 * Events stored under one version are stale under any other.
 */
export function getParserVersion(adapter: Pick<SourceAdapter, 'parserVersion'>): string {
  return `n${USAGE_EVENT_NORMALIZATION_VERSION}.p${adapter.parserVersion ?? 1}`;
}

function isSameDependencyFingerprint(
  left: FileDependencyFingerprint | undefined,
  right: FileDependencyFingerprint | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    left.path === right.path &&
    left.exists === right.exists &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

/**
 * The stored fingerprint again, when the adapter's dependency list follows its file
 * (`dependenciesFollowFile`), the parser is the same, and the file and every stored
 * dependency still exist with the stored size and mtime. Undefined otherwise: a dependency
 * stored as missing may have turned up, and only `getParseDependencies` can tell.
 */
async function confirmPreviousFingerprint(
  adapter: SourceAdapter,
  primaryFingerprint: FileDependencyFingerprint,
  previous: FileFingerprint | undefined,
): Promise<FileFingerprint | undefined> {
  const parserVersion = getParserVersion(adapter);

  if (
    adapter.capabilities?.dependenciesFollowFile !== true ||
    previous?.parserVersion !== parserVersion ||
    previous.dependencies.some((dependency) => !dependency.exists) ||
    !isSameDependencyFingerprint(
      previous.dependencies.find((dependency) => dependency.path === primaryFingerprint.path),
      primaryFingerprint,
    )
  ) {
    return undefined;
  }

  const dependencyPaths = previous.dependencies
    .map((dependency) => dependency.path)
    .filter((dependencyPath) => dependencyPath !== primaryFingerprint.path)
    .sort(compareByCodePoint);
  const dependencyFingerprints: FileDependencyFingerprint[] = [primaryFingerprint];

  for (const dependencyPath of dependencyPaths) {
    const dependencyFingerprint = await createFileDependencyFingerprint(dependencyPath, {
      allowMissing: true,
    });

    if (
      !dependencyFingerprint ||
      !isSameDependencyFingerprint(
        dependencyFingerprint,
        previous.dependencies.find((dependency) => dependency.path === dependencyPath),
      )
    ) {
      return undefined;
    }

    dependencyFingerprints.push(dependencyFingerprint);
  }

  return { parserVersion, dependencies: dependencyFingerprints };
}

/**
 * The file's fingerprint: its size and mtime, those of its parse dependencies, and the
 * parser version. Pass the fingerprint stored for the file as `previous` to skip
 * `getParseDependencies` while nothing it lists has changed (adapters that declare
 * `dependenciesFollowFile` only).
 */
export async function getFileFingerprint(
  adapter: SourceAdapter,
  filePath: string,
  previous?: FileFingerprint,
): Promise<FileFingerprint | undefined> {
  const primaryFingerprint = await createFileDependencyFingerprint(filePath, {
    allowMissing: false,
  });

  if (!primaryFingerprint) {
    return undefined;
  }

  const confirmedFingerprint = await confirmPreviousFingerprint(
    adapter,
    primaryFingerprint,
    previous,
  );

  if (confirmedFingerprint) {
    return confirmedFingerprint;
  }

  const additionalDependencyPaths = adapter.getParseDependencies
    ? await adapter.getParseDependencies(filePath)
    : [];
  const uniqueAdditionalDependencyPaths = [...new Set(additionalDependencyPaths)]
    .filter((dependencyPath) => dependencyPath !== filePath)
    .sort(compareByCodePoint);
  const dependencyFingerprints: FileDependencyFingerprint[] = [primaryFingerprint];

  for (const dependencyPath of uniqueAdditionalDependencyPaths) {
    const dependencyFingerprint = await createFileDependencyFingerprint(dependencyPath, {
      allowMissing: true,
    });

    if (!dependencyFingerprint) {
      return undefined;
    }

    dependencyFingerprints.push(dependencyFingerprint);
  }

  return {
    parserVersion: getParserVersion(adapter),
    dependencies: dependencyFingerprints,
  };
}

export async function getFileByteSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

export function getPrimaryFingerprintByteSize(
  fingerprint: FileFingerprint | undefined,
): number | undefined {
  const primaryFingerprint = fingerprint?.dependencies[0];

  if (!primaryFingerprint?.exists || primaryFingerprint.size === undefined) {
    return undefined;
  }

  return Math.max(0, primaryFingerprint.size);
}

/** Newest mtime among the file and its parse dependencies that exist. */
export function getNewestFingerprintMtimeMs(fingerprint: FileFingerprint): number {
  let newestMtimeMs = Number.NEGATIVE_INFINITY;

  for (const dependency of fingerprint.dependencies) {
    if (dependency.exists && dependency.mtimeMs !== undefined) {
      newestMtimeMs = Math.max(newestMtimeMs, dependency.mtimeMs);
    }
  }

  return newestMtimeMs;
}
