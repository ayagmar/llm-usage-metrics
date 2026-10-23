import { lstatSync, readFileSync, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';

import { splitKeySegments, toParentProjectKey, toProjectKey } from '../aggregate/project-key.js';
import type { UsageEvent } from '../domain/usage-event.js';

/** The shortest repository name a worktree path is matched against (`pi` would match too much). */
const MIN_MATCHED_NAME_LENGTH = 4;

/** A directory with a `.git` entry: a repository, or a worktree of the repository at `repoKey`. */
type GitRoot = { root: string; repoKey: string };

export type WorktreeRoots = {
  /** The key of the repository a project key belongs to, or undefined when it keeps its own. */
  repoKeyOf: (key: string) => string | undefined;
  /**
   * Git roots found on disk that the store does not record yet, with the repository each
   * belongs to (a repository belongs to itself).
   */
  newRoots: Map<string, string>;
};

/** The repository of the worktree whose `.git` file this is, from its `gitdir:` line. */
function readWorktreeRepoKey(worktree: string, markerPath: string): string | undefined {
  const line = readFileSync(markerPath, 'utf8')
    .split('\n')
    .find((candidate) => candidate.startsWith('gitdir:'));

  if (line === undefined) {
    return undefined;
  }

  // Exactly `<repo>/.git/worktrees/<name>`: a submodule's gitdir, `.git/modules/<name>` or
  // `.git/worktrees/<name>/modules/<name>` inside a worktree, is no worktree.
  const gitDir = path.resolve(worktree, line.slice('gitdir:'.length).trim());
  const needle = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const index = gitDir.lastIndexOf(needle);

  return index > 0 && !gitDir.includes(path.sep, index + needle.length)
    ? toProjectKey(gitDir.slice(0, index))
    : undefined;
}

/** What the `.git` entry of `directory` says it is: a repository, a worktree, or neither. */
function readGitRoot(directory: string): GitRoot | undefined {
  const markerPath = path.join(directory, '.git');
  let stats: Stats | undefined;

  try {
    stats = lstatSync(markerPath, { throwIfNoEntry: false });

    if (stats?.isDirectory()) {
      return { root: directory, repoKey: directory };
    }

    const repoKey = stats?.isFile() ? readWorktreeRepoKey(directory, markerPath) : undefined;
    return repoKey === undefined ? undefined : { root: directory, repoKey };
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
 * as its repository. `keys` are this machine's: another machine's paths name nothing here.
 * A key resolves, nearest first, through:
 *
 * 1. the nearest git root at or above the key: one `stored` records (found on disk by an
 *    earlier run, maybe deleted since), or a `.git` entry read from disk up to (not
 *    including) the home directory, the record winning at the same directory. A worktree
 *    moves to its repository, keeping the path below it; a repository keeps the key;
 * 2. otherwise, a path segment named `<repo>-…`, `…-<repo>` (or with `_`) after a known
 *    repository (found on disk or in `stored`), case-insensitively, the longest name
 *    winning. A name shorter than 4 characters matches nothing, and one several repositories
 *    share matches only the one of them with worktrees.
 *
 * Disk reads are cached per directory. `repoKeyOf` also resolves a key not in `keys`, such
 * as a `--repo` path, and remembers every answer.
 */
export function resolveWorktreeRoots(
  keys: Iterable<string>,
  stored: ReadonlyMap<string, string>,
  homeDir: string = os.homedir(),
): WorktreeRoots {
  // Windows paths ignore case and take either separator.
  const comparable = (value: string): string =>
    process.platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value;
  const homeKey = comparable(toProjectKey(homeDir) ?? homeDir);
  const isHomeOrAbove = (directory: string): boolean => {
    const candidate = comparable(directory);
    return (
      homeKey === candidate ||
      homeKey.startsWith(candidate.endsWith(path.sep) ? candidate : candidate + path.sep)
    );
  };
  const located = new Map<string, GitRoot | undefined>();

  // The nearest git root at or above `directory` on disk; the home directory and those above
  // it are not read, since a home under git would otherwise hold every project.
  const locate = (directory: string): GitRoot | undefined => {
    if (located.has(directory)) {
      return located.get(directory);
    }

    let root: GitRoot | undefined;

    if (path.isAbsolute(directory) && !isHomeOrAbove(directory)) {
      root = readGitRoot(directory);

      if (root === undefined) {
        const parent = toParentProjectKey(directory);
        root = parent === undefined ? undefined : locate(parent);
      }
    }

    located.set(directory, root);
    return root;
  };

  const roots = new Map(stored);
  const newRoots = new Map<string, string>();

  for (const key of keys) {
    const found = locate(key);

    // The first record of a path stands: a path reused later would otherwise move its past.
    if (found !== undefined && !roots.has(found.root)) {
      roots.set(found.root, found.repoKey);
      newRoots.set(found.root, found.repoKey);
    }
  }

  // Each name's repository. When repositories share a name, the one with worktrees takes it
  // (another clone, such as a reference checkout, has none); with none or several, nobody.
  const repoKeysByName = new Map<string, string[]>();
  const worktreeRepoKeys = new Set<string>();

  for (const [root, repoKey] of roots) {
    if (root !== repoKey) {
      worktreeRepoKeys.add(repoKey);
    }
  }

  for (const repoKey of [...new Set(roots.values())].sort(compareByCodePoint)) {
    const name = toRepositoryName(repoKey);

    if (name !== undefined && name.length >= MIN_MATCHED_NAME_LENGTH) {
      repoKeysByName.set(name, [...(repoKeysByName.get(name) ?? []), repoKey]);
    }
  }

  const repoKeyByName = new Map<string, string>();

  for (const [name, repoKeys] of repoKeysByName) {
    const candidates =
      repoKeys.length === 1
        ? repoKeys
        : repoKeys.filter((repoKey) => worktreeRepoKeys.has(repoKey));

    if (candidates.length === 1) {
      repoKeyByName.set(name, candidates[0]);
    }
  }

  const matchByName = (key: string): string | undefined => {
    let best: { name: string; repoKey: string } | undefined;
    const consider = (name: string) => {
      const repoKey = repoKeyByName.get(name);

      if (
        repoKey !== undefined &&
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

  // A worktree's key moves to its repository with the path below it; a repository keeps it.
  const moveBelow = (key: string, root: string, repoKey: string): string | undefined =>
    root === repoKey ? undefined : repoKey + key.slice(root.length);

  // The nearest recorded root wins, and at the disk's root the record does too: a deleted
  // worktree inside its repository's folder still resolves, and a reused path keeps the
  // repository first recorded there.
  const resolve = (key: string): string | undefined => {
    const found = locate(key);

    for (let ancestor: string | undefined = key; ancestor !== undefined;) {
      const repoKey = roots.get(ancestor);

      if (repoKey !== undefined) {
        return moveBelow(key, ancestor, repoKey);
      }

      if (ancestor === found?.root) {
        return moveBelow(key, found.root, found.repoKey);
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
    newRoots,
  };
}

/**
 * The events, with each of this machine's that ran in a worktree moved to its repository's
 * key (see `resolveWorktreeRoots`). Other machines' events, and events that keep their
 * project, are returned as they are.
 */
export function moveEventsToRepositories(
  eventLists: readonly (readonly UsageEvent[])[],
  repoKeyOf: (key: string) => string | undefined,
): UsageEvent[][] {
  const movedRoots = new Map<string, string | undefined>();

  return eventLists.map((events) =>
    events.map((event) => {
      const repoRoot = event.repoRoot;

      if (repoRoot === undefined || event.machine !== undefined) {
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
