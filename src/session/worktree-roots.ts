import { lstatSync, readFileSync, type Stats } from 'node:fs';
import path from 'node:path';

import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';

import { splitKeySegments, toParentProjectKey, toProjectKey } from '../aggregate/project-key.js';
import type { UsageEvent } from '../domain/usage-event.js';

/** The shortest repository name a worktree path is matched against (`pi` would match too much). */
const MIN_MATCHED_NAME_LENGTH = 4;

type GitMarker = { kind: 'repository' } | { kind: 'worktree'; repoKey: string };

export type WorktreeRoots = {
  /** The key of the repository a project key belongs to, or undefined when it keeps its own. */
  repoKeyOf: (key: string) => string | undefined;
  /** Worktrees found on disk that the store does not record yet, with their repository's key. */
  newWorktrees: Map<string, string>;
};

/** The repository of the worktree whose `.git` file this is, from its `gitdir:` line. */
function readWorktreeRepoKey(worktreeKey: string, markerPath: string): string | undefined {
  const line = readFileSync(markerPath, 'utf8')
    .split('\n')
    .find((candidate) => candidate.startsWith('gitdir:'));

  if (line === undefined) {
    return undefined;
  }

  // `<repo>/.git/worktrees/<name>`; a submodule's `.git/modules/<name>` is not a worktree.
  const gitDir = path.resolve(worktreeKey, line.slice('gitdir:'.length).trim());
  const needle = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const index = gitDir.lastIndexOf(needle);

  return index > 0 ? toProjectKey(gitDir.slice(0, index)) : undefined;
}

/** What the `.git` entry of the directory at `key` says it is, if it has one. */
function readGitMarker(key: string): GitMarker | undefined {
  // A key recorded on another platform, or a relative one, names no directory here.
  if (!path.isAbsolute(key)) {
    return undefined;
  }

  const markerPath = path.join(key, '.git');
  let stats: Stats | undefined;

  try {
    stats = lstatSync(markerPath, { throwIfNoEntry: false });

    if (stats?.isDirectory()) {
      return { kind: 'repository' };
    }

    const repoKey = stats?.isFile() ? readWorktreeRepoKey(key, markerPath) : undefined;
    return repoKey === undefined ? undefined : { kind: 'worktree', repoKey };
  } catch {
    // Unreadable (permissions, a file in the path): treated as no marker.
    return undefined;
  }
}

/** The last segment of a key, lower-cased: the repository's name for matching. */
function toRepositoryName(key: string): string | undefined {
  return splitKeySegments(key).at(-1)?.toLowerCase();
}

/**
 * Where each project key's usage belongs when it ran in a git worktree, so a worktree counts
 * as its repository. A key resolves, nearest first, through:
 *
 * 1. its own `.git` file on disk, or a worktree among `keys` or recorded in `stored` (found
 *    on disk by an earlier run, maybe deleted since) that it sits in, keeping the path below;
 * 2. otherwise, a path segment named `<repo>-…`, `…-<repo>` (or with `_`) after a repository
 *    found on disk among `keys` or recorded in `stored`, case-insensitively, the longest name
 *    winning. A name shared
 *    by two repositories, or shorter than 4 characters, matches nothing.
 *
 * A repository, or a directory inside one, keeps its key. `repoKeyOf` reads the disk for a key
 * not in `keys`, such as a `--repo` path, and remembers every answer.
 */
export function resolveWorktreeRoots(
  keys: Iterable<string>,
  stored: ReadonlyMap<string, string>,
): WorktreeRoots {
  const markers = new Map<string, GitMarker | undefined>();
  const markerOf = (key: string): GitMarker | undefined => {
    if (!markers.has(key)) {
      markers.set(key, readGitMarker(key));
    }

    return markers.get(key);
  };

  const worktrees = new Map(stored);
  const newWorktrees = new Map<string, string>();
  const repoKeys = new Set<string>();

  for (const key of keys) {
    const marker = markerOf(key);

    if (marker?.kind === 'repository') {
      repoKeys.add(key);
      // A path reused for a repository is no longer the worktree recorded there.
      worktrees.delete(key);
    } else if (marker?.kind === 'worktree') {
      repoKeys.add(marker.repoKey);

      if (stored.get(key) !== marker.repoKey) {
        newWorktrees.set(key, marker.repoKey);
      }

      worktrees.set(key, marker.repoKey);
    }
  }

  for (const repoKey of stored.values()) {
    repoKeys.add(repoKey);
  }

  // Each name's repository; null when two repositories share it.
  const repoKeyByName = new Map<string, string | null>();

  for (const repoKey of [...repoKeys].sort(compareByCodePoint)) {
    const name = toRepositoryName(repoKey);

    if (name !== undefined && name.length >= MIN_MATCHED_NAME_LENGTH) {
      repoKeyByName.set(name, repoKeyByName.has(name) ? null : repoKey);
    }
  }

  const matchByName = (key: string): string | undefined => {
    let best: { name: string; repoKey: string } | undefined;
    const consider = (name: string) => {
      const repoKey = repoKeyByName.get(name);

      if (
        repoKey &&
        (best === undefined ||
          name.length > best.name.length ||
          (name.length === best.name.length && compareByCodePoint(repoKey, best.repoKey) < 0))
      ) {
        best = { name, repoKey };
      }
    };

    for (const segment of splitKeySegments(key)) {
      const lowered = segment.toLowerCase();

      for (let index = 0; index < lowered.length; index += 1) {
        if (lowered[index] === '-' || lowered[index] === '_') {
          consider(lowered.slice(0, index));
          consider(lowered.slice(index + 1));
        }
      }
    }

    return best?.repoKey;
  };

  // Ancestors come from `keys` and the store only: reading the disk above every key would
  // cost a lookup per level, and a home directory under git would hold every project.
  const resolve = (key: string): string | undefined => {
    const marker = markerOf(key);

    if (marker !== undefined) {
      return marker.kind === 'worktree' ? marker.repoKey : undefined;
    }

    for (let ancestor: string | undefined = key; ancestor !== undefined;) {
      const worktreeRepoKey = worktrees.get(ancestor);

      if (worktreeRepoKey !== undefined) {
        return worktreeRepoKey + key.slice(ancestor.length);
      }

      if (repoKeys.has(ancestor)) {
        return undefined;
      }

      ancestor = toParentProjectKey(ancestor);
    }

    return matchByName(key);
  };
  const resolved = new Map<string, string | undefined>();

  return {
    repoKeyOf: (key) => {
      if (!resolved.has(key)) {
        resolved.set(key, resolve(key));
      }

      return resolved.get(key);
    },
    newWorktrees,
  };
}

/**
 * The events, with each one that ran in a worktree moved to its repository's key (see
 * `resolveWorktreeRoots`). Events that keep their project are returned as they are.
 */
export function moveEventsToRepositories(
  eventLists: readonly (readonly UsageEvent[])[],
  repoKeyOf: (key: string) => string | undefined,
): UsageEvent[][] {
  const movedRoots = new Map<string, string | undefined>();

  return eventLists.map((events) =>
    events.map((event) => {
      const repoRoot = event.repoRoot;

      if (repoRoot === undefined) {
        return event;
      }

      let moved = movedRoots.get(repoRoot);

      if (moved === undefined && !movedRoots.has(repoRoot)) {
        const key = toProjectKey(repoRoot);
        moved = key === undefined ? undefined : repoKeyOf(key);
        movedRoots.set(repoRoot, moved);
      }

      return moved === undefined ? event : { ...event, repoRoot: moved };
    }),
  );
}
