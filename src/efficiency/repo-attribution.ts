import { access, constants, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { UsageEvent } from '../domain/usage-event.js';

export type RepoAttributionResult = {
  matchedEvents: UsageEvent[];
  /** The input events behind `matchedEvents`, in the same order, for identity lookups. */
  matchedSourceEvents: UsageEvent[];
  matchedEventCount: number;
  excludedEventCount: number;
  unattributedEventCount: number;
};

export type RepoRootResolver = (pathHint: string) => Promise<string | undefined>;

async function hasGitMarker(directoryPath: string): Promise<boolean> {
  try {
    await access(path.join(directoryPath, '.git'), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeComparablePath(value: string): string {
  const normalizedPath = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
}

async function resolveComparablePath(value: string): Promise<string> {
  const resolvedPath = path.resolve(value);

  try {
    return normalizeComparablePath(await realpath(resolvedPath));
  } catch {
    return normalizeComparablePath(resolvedPath);
  }
}

export async function resolveRepoRootFromPathHint(pathHint: string): Promise<string | undefined> {
  const trimmedPath = pathHint.trim();

  if (!trimmedPath) {
    return undefined;
  }

  let currentPath = path.resolve(trimmedPath);

  for (;;) {
    if (await hasGitMarker(currentPath)) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);

    if (parentPath === currentPath) {
      return undefined;
    }

    currentPath = parentPath;
  }
}

export async function attributeUsageEventsToRepo(
  events: UsageEvent[],
  repoDir: string,
  resolveRepoRoot: RepoRootResolver = resolveRepoRootFromPathHint,
): Promise<RepoAttributionResult> {
  const resolvedTargetRepoRoot = await resolveRepoRoot(repoDir).catch(() => undefined);
  const targetRepoPath = await resolveComparablePath(resolvedTargetRepoRoot ?? repoDir);
  const rootCache = new Map<
    string,
    Promise<{ resolvedRoot: string; comparableRoot: string } | undefined>
  >();
  const matchedEvents: UsageEvent[] = [];
  const matchedSourceEvents: UsageEvent[] = [];
  let excludedEventCount = 0;
  let unattributedEventCount = 0;

  for (const event of events) {
    if (!event.repoRoot) {
      unattributedEventCount += 1;
      continue;
    }
    const eventRepoRoot = event.repoRoot;

    const cachedRootPromise =
      rootCache.get(eventRepoRoot) ??
      (async () => {
        const resolvedRoot = await resolveRepoRoot(eventRepoRoot).catch(() => undefined);

        if (!resolvedRoot) {
          return undefined;
        }

        return {
          resolvedRoot,
          comparableRoot: await resolveComparablePath(resolvedRoot),
        };
      })();
    rootCache.set(eventRepoRoot, cachedRootPromise);
    const resolvedRoot = await cachedRootPromise;

    if (!resolvedRoot) {
      unattributedEventCount += 1;
      continue;
    }

    if (resolvedRoot.comparableRoot !== targetRepoPath) {
      excludedEventCount += 1;
      continue;
    }

    matchedEvents.push({
      ...event,
      repoRoot: resolvedRoot.resolvedRoot,
    });
    matchedSourceEvents.push(event);
  }

  return {
    matchedEvents,
    matchedSourceEvents,
    matchedEventCount: matchedEvents.length,
    excludedEventCount,
    unattributedEventCount,
  };
}
