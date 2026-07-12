import { stat } from 'node:fs/promises';

import type {
  EventStoreDependencyFingerprint,
  EventStoreFileFingerprint,
} from '../../persistence/event-store.js';
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

export async function getParseFileFingerprint(
  adapter: SourceAdapter,
  filePath: string,
): Promise<{ dependencies: ParseDependencyFingerprint[] } | undefined> {
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
