import { stat } from 'node:fs/promises';

import type {
  EventStoreDependencyFingerprint,
  EventStoreFileFingerprint,
} from '../../persistence/event-store.js';
import { USAGE_EVENT_NORMALIZATION_VERSION } from '../../domain/usage-event.js';
import type { SourceAdapter } from '../../sources/source-adapter.js';
import { compareByCodePoint } from '../../utils/compare-by-code-point.js';

type ParseDependencyFingerprint = EventStoreDependencyFingerprint;

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function createParseDependencyFingerprint(
  filePath: string,
  options: { allowMissing: boolean },
): Promise<ParseDependencyFingerprint | undefined> {
  try {
    const fileStat = await stat(filePath);

    return {
      path: filePath,
      exists: true,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch (error) {
    if (options.allowMissing && isMissingPathError(error)) {
      return {
        path: filePath,
        exists: false,
      };
    }

    return undefined;
  }
}

export function getParserVersion(adapter: Pick<SourceAdapter, 'parserVersion'>): string {
  return `n${USAGE_EVENT_NORMALIZATION_VERSION}.p${adapter.parserVersion ?? 1}`;
}

export async function getParseFileFingerprint(
  adapter: SourceAdapter,
  filePath: string,
): Promise<EventStoreFileFingerprint | undefined> {
  const primaryFingerprint = await createParseDependencyFingerprint(filePath, {
    allowMissing: false,
  });

  if (!primaryFingerprint) {
    return undefined;
  }

  const additionalDependencyPaths = adapter.getParseDependencies
    ? await adapter.getParseDependencies(filePath)
    : [];
  const uniqueAdditionalDependencyPaths = [...new Set(additionalDependencyPaths)]
    .filter((dependencyPath) => dependencyPath !== filePath)
    .sort(compareByCodePoint);
  const dependencyFingerprints: ParseDependencyFingerprint[] = [primaryFingerprint];

  for (const dependencyPath of uniqueAdditionalDependencyPaths) {
    const dependencyFingerprint = await createParseDependencyFingerprint(dependencyPath, {
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
  fingerprint: EventStoreFileFingerprint | undefined,
): number | undefined {
  const primaryFingerprint = fingerprint?.dependencies[0];

  if (!primaryFingerprint?.exists || primaryFingerprint.size === undefined) {
    return undefined;
  }

  return Math.max(0, primaryFingerprint.size);
}

/** Newest mtime among the file and its parse dependencies that exist. */
export function getNewestFingerprintMtimeMs(fingerprint: EventStoreFileFingerprint): number {
  let newestMtimeMs = Number.NEGATIVE_INFINITY;

  for (const dependency of fingerprint.dependencies) {
    if (dependency.exists && dependency.mtimeMs !== undefined) {
      newestMtimeMs = Math.max(newestMtimeMs, dependency.mtimeMs);
    }
  }

  return newestMtimeMs;
}
