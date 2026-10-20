import os from 'node:os';
import path from 'node:path';

import {
  stripTrailingSeparators,
  toProjectKey,
  UNATTRIBUTED_PROJECT_LABEL,
} from '../aggregate/project-key.js';
import type { UsageEvent } from '../domain/usage-event.js';

/**
 * One `--repo` value. `path` matches that root and the roots under it; `suffix` matches
 * keys ending in its segments; `unattributed` matches events without a repository root.
 */
export type RepoFilterValue =
  | { kind: 'path'; input: string; path: string }
  | { kind: 'suffix'; input: string; suffix: string }
  | { kind: 'unattributed'; input: string };

export type RepoFilter = readonly RepoFilterValue[];

export type RepoFilterContext = {
  cwd?: string;
  homeDir?: string;
};

const ABSOLUTE_PATTERN = /^(?:\/|[A-Za-z]:)/u;
const RELATIVE_PATTERN = /^\.\.?(?:\/|$)/u;
const HOME_PATTERN = /^~(?:\/|$)/u;

const DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;
const UNC_ROOT_PATTERN = /^\/\/[^/]+(?:\/[^/]+)?/u;

/**
 * Forward slashes, an upper-case drive letter (Windows ignores its case), no trailing
 * separator except a bare root (`/`, `C:/`).
 */
function normalizeSeparators(value: string): string {
  return stripTrailingSeparators(
    value.replaceAll('\\', '/').replace(DRIVE_PREFIX_PATTERN, (drive) => drive.toUpperCase()),
  );
}

/** Resolves `.` and `..` below the root (`/`, `C:`, `//host/share`) of a `/`-separated path. */
function normalizeAbsolutePath(value: string): string {
  const root = UNC_ROOT_PATTERN.exec(value)?.[0] ?? DRIVE_PREFIX_PATTERN.exec(value)?.[0] ?? '';
  return normalizeSeparators(root + path.posix.normalize(`/${value.slice(root.length)}`));
}

/** A `--repo` path, folded like project keys so a path inside a worktree or dependency selects its project. */
function toPathValue(input: string, value: string): RepoFilterValue {
  return { kind: 'path', input, path: toProjectKey(value) ?? value };
}

function toRepoFilterValue(input: string, context: RepoFilterContext): RepoFilterValue {
  if (input === UNATTRIBUTED_PROJECT_LABEL) {
    return { kind: 'unattributed', input };
  }

  const value = input.replaceAll('\\', '/');

  if (RELATIVE_PATTERN.test(value)) {
    return toPathValue(
      input,
      normalizeSeparators(path.resolve(context.cwd ?? process.cwd(), value)),
    );
  }

  if (HOME_PATTERN.test(value)) {
    return toPathValue(
      input,
      normalizeSeparators(path.join(context.homeDir ?? os.homedir(), value.slice(1))),
    );
  }

  if (ABSOLUTE_PATTERN.test(value)) {
    return toPathValue(input, normalizeAbsolutePath(value));
  }

  const suffix = normalizeSeparators(value);
  return { kind: 'suffix', input, suffix: toProjectKey(suffix) ?? suffix };
}

/**
 * Normalizes `--repo` values (repeatable, comma-separated, trimmed, case kept). `.`, `..`,
 * `~` and paths under them resolve against the working and home directories.
 */
export function normalizeRepoFilter(
  repo: string | string[] | undefined,
  context: RepoFilterContext = {},
): RepoFilter | undefined {
  if (!repo || (Array.isArray(repo) && repo.length === 0)) {
    return undefined;
  }

  const inputs = (Array.isArray(repo) ? repo : [repo])
    .flatMap((candidate) => candidate.split(','))
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);

  if (inputs.length === 0) {
    throw new Error('--repo must contain at least one non-empty project');
  }

  return [...new Set(inputs)].map((input) => toRepoFilterValue(input, context));
}

/** Whether `key` is `root` or under it; a UNC key (`//host/share`) is never under `/`. */
function matchesPath(key: string, root: string): boolean {
  if (key.startsWith('//') !== root.startsWith('//')) {
    return false;
  }

  return key === root || key.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** Whether a `--repo` value selects the normalized project key (`undefined`: no root). */
function valueMatchesKey(value: RepoFilterValue, key: string | undefined): boolean {
  if (value.kind === 'unattributed') {
    return key === undefined;
  }

  if (key === undefined) {
    return false;
  }

  return value.kind === 'path'
    ? matchesPath(key, value.path)
    : key === value.suffix || key.endsWith(`/${value.suffix}`);
}

/** A project key in the form `--repo` values take, so an absolute root matches itself. */
function toComparableKey(repoRoot: string | undefined): string | undefined {
  const key = toProjectKey(repoRoot)?.replaceAll('\\', '/');

  if (key === undefined) {
    return undefined;
  }

  return ABSOLUTE_PATTERN.test(key) ? normalizeAbsolutePath(key) : normalizeSeparators(key);
}

/** Keeps the events of the selected projects; without a filter, returns `events` itself. */
export function applyRepoFilter<Event extends Pick<UsageEvent, 'repoRoot'>>(
  events: Event[],
  filter: RepoFilter | undefined,
): Event[] {
  if (!filter) {
    return events;
  }

  const matchesByRepoRoot = new Map<string | undefined, boolean>();

  return events.filter((event) => {
    let matches = matchesByRepoRoot.get(event.repoRoot);

    if (matches === undefined) {
      const key = toComparableKey(event.repoRoot);
      matches = filter.some((value) => valueMatchesKey(value, key));
      matchesByRepoRoot.set(event.repoRoot, matches);
    }

    return matches;
  });
}

/** The `--repo` values, as typed, that select none of the events' repository roots. */
export function findUnmatchedRepoValues(
  filter: RepoFilter,
  repoRoots: Iterable<string | undefined>,
): string[] {
  const keys = new Set<string | undefined>();

  for (const repoRoot of repoRoots) {
    keys.add(toComparableKey(repoRoot));
  }

  return filter
    .filter((value) => ![...keys].some((key) => valueMatchesKey(value, key)))
    .map((value) => value.input);
}
