import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  moveProjectKeyBelow,
  toComparableProjectKey,
  toParentProjectKey,
} from '../aggregate/project-key.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { moveEventRepoRoots } from './worktree-roots.js';

/**
 * A remote URL as `host/path`, lower-cased, without scheme, credentials, port or `.git`, so
 * the ssh and https URLs of one repository match: `git@github.com:Me/App.git` and
 * `https://token@github.com/me/app` are both `github.com/me/app`. Undefined for a local
 * path or a URL without a host, which names no shared repository.
 */
export function normalizeGitRemote(url: string): string | undefined {
  const text = url.trim();
  let host: string;
  let repoPath: string;

  if (text.includes('://')) {
    let parsed: URL;

    try {
      parsed = new URL(text);
    } catch {
      return undefined;
    }

    if (parsed.protocol === 'file:') {
      return undefined;
    }

    host = parsed.hostname;
    repoPath = decodeURIComponent(parsed.pathname);
  } else {
    // scp-like `[user@]host:path`; a path with a separator before any `:`, or a drive
    // (`C:\\repo`), is local.
    const colon = text.indexOf(':');
    const slash = text.search(/[\\/]/u);

    if (colon <= 1 || (slash >= 0 && slash < colon)) {
      return undefined;
    }

    host = text.slice(text.lastIndexOf('@', colon) + 1, colon);
    repoPath = text.slice(colon + 1);
  }

  const segments = repoPath.split('/').filter((segment) => segment.length > 0);
  const last = segments.at(-1);

  if (host.length === 0 || last === undefined) {
    return undefined;
  }

  if (last.endsWith('.git')) {
    segments[segments.length - 1] = last.slice(0, -'.git'.length);
  }

  return [host, ...segments].join('/').toLowerCase();
}

/** Whether a git config section header (`[remote "origin"] # note`) opens `remote.origin`. */
function isOriginSection(line: string): boolean {
  const end = line.indexOf(']');
  const header = line.slice(1, end < 0 ? undefined : end).trim();
  const space = header.indexOf(' ');

  // Section names ignore case; subsection names do not.
  return (
    space > 0 &&
    header.slice(0, space).toLowerCase() === 'remote' &&
    header.slice(space + 1).trim() === '"origin"'
  );
}

/** A git config value without surrounding quotes or a trailing `#`/`;` comment. */
function readConfigValue(text: string): string {
  const value = text.trim();

  if (value.startsWith('"')) {
    const close = value.indexOf('"', 1);
    return value.slice(1, close < 0 ? undefined : close);
  }

  const comment = value.search(/[#;]/u);
  return (comment < 0 ? value : value.slice(0, comment)).trim();
}

/**
 * The normalized `origin` URL in a git config's text, or undefined without one. Reads the
 * repository's own config only: `[include]` files are not followed.
 */
export function readOriginRemote(configText: string): string | undefined {
  let inOrigin = false;

  for (const rawLine of configText.split('\n')) {
    const line = rawLine.trim();

    if (line.startsWith('[')) {
      inOrigin = isOriginSection(line);
      continue;
    }

    const equals = line.indexOf('=');

    if (inOrigin && equals > 0 && line.slice(0, equals).trim().toLowerCase() === 'url') {
      return normalizeGitRemote(readConfigValue(line.slice(equals + 1)));
    }
  }

  return undefined;
}

/** The normalized `origin` of the repository at `repoKey`, read from its `.git/config`. */
export function readRepositoryRemote(repoKey: string): string | undefined {
  try {
    return readOriginRemote(readFileSync(path.join(repoKey, '.git', 'config'), 'utf8'));
  } catch {
    // No config, or unreadable: the repository has no known remote.
    return undefined;
  }
}

/**
 * Each git root (a repository or a worktree) with the normalized remote of its repository,
 * for roots whose repository has one. `roots` maps each root to its repository's key.
 */
export function collectGitRootRemotes(
  roots: ReadonlyMap<string, string>,
  readRemote: (repoKey: string) => string | undefined = readRepositoryRemote,
): Map<string, string> {
  const remotesByRepo = new Map<string, string | undefined>();
  const remotes = new Map<string, string>();

  for (const [root, repoKey] of roots) {
    if (!remotesByRepo.has(repoKey)) {
      remotesByRepo.set(repoKey, readRemote(repoKey));
    }

    const remote = remotesByRepo.get(repoKey);

    if (remote !== undefined) {
      remotes.set(root, remote);
    }
  }

  return remotes;
}

/**
 * The events of other machines, each moved to the repository on this machine with the same
 * remote: the nearest git root at or above its project key in its machine's `gitRemotes`
 * names the remote, and the path below that root is kept. A remote that no repository, or
 * several, on this machine has moves nothing. This machine's events stay as they are.
 */
export function moveMachineEventsToLocalRepositories(
  eventLists: readonly (readonly UsageEvent[])[],
  localRepoRemotes: ReadonlyMap<string, string>,
  machineRemotes: ReadonlyMap<string, ReadonlyMap<string, string>>,
): UsageEvent[][] {
  const localRepoByRemote = new Map<string, string | null>();

  for (const [repoKey, remote] of localRepoRemotes) {
    // Two clones of one remote here: which one is the project is unknown.
    localRepoByRemote.set(remote, localRepoByRemote.has(remote) ? null : repoKey);
  }

  let moved = eventLists.map((events) => [...events]);

  for (const [machine, remotes] of machineRemotes) {
    const comparableRemotes = new Map(
      [...remotes].map(([root, remote]) => [toComparableProjectKey(root), remote]),
    );
    const repoKeyOf = (key: string): string | undefined => {
      for (let ancestor: string | undefined = key; ancestor !== undefined;) {
        const remote = comparableRemotes.get(toComparableProjectKey(ancestor));

        if (remote !== undefined) {
          const repoKey = localRepoByRemote.get(remote);
          return repoKey ? moveProjectKeyBelow(key, ancestor, repoKey) : undefined;
        }

        ancestor = toParentProjectKey(ancestor);
      }

      return undefined;
    };

    moved = moveEventRepoRoots(moved, repoKeyOf, (event) => event.machine === machine);
  }

  return moved;
}
