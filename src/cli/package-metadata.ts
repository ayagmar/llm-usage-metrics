import { createRequire } from 'node:module';

import { asRecord } from '@ayagmar/agent-sessions/internal';

export type PackageMetadata = {
  packageName: string;
  packageVersion: string;
};

const DEFAULT_PACKAGE_NAME = 'llm-usage-metrics';
const DEFAULT_PACKAGE_VERSION = '0.0.0';

const defaultPackageJsonCandidates = ['../package.json', '../../package.json'] as const;

type JsonLoader = (path: string) => unknown;

function normalizeMetadata(candidate: unknown): PackageMetadata | undefined {
  const packageJson = asRecord(candidate);

  if (!packageJson) {
    return undefined;
  }

  const packageName = typeof packageJson.name === 'string' ? packageJson.name.trim() : undefined;
  const packageVersion =
    typeof packageJson.version === 'string' ? packageJson.version.trim() : undefined;

  if (!packageName || !packageVersion) {
    return undefined;
  }

  return {
    packageName,
    packageVersion,
  };
}

export function resolvePackageMetadata(
  loadJson: JsonLoader,
  packageJsonCandidates: readonly string[] = defaultPackageJsonCandidates,
): PackageMetadata {
  for (const candidatePath of packageJsonCandidates) {
    try {
      const metadata = normalizeMetadata(loadJson(candidatePath));

      if (metadata) {
        return metadata;
      }
    } catch {
      continue;
    }
  }

  return {
    packageName: DEFAULT_PACKAGE_NAME,
    packageVersion: DEFAULT_PACKAGE_VERSION,
  };
}

export function loadPackageMetadataFromRuntime(): PackageMetadata {
  const require = createRequire(import.meta.url);
  return resolvePackageMetadata((candidatePath) => require(candidatePath));
}
