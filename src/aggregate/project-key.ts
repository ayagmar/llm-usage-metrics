import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';

/** The label of usage without a repository root. */
export const UNATTRIBUTED_PROJECT_LABEL = '(unattributed)';

const DRIVE_ROOT_PATTERN = /^[A-Za-z]:[\\/]$/u;
const DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;

function isSeparator(character: string | undefined): boolean {
  return character === '/' || character === '\\';
}

/** Whether `value` is a bare root such as `/`, `\` or `C:\`, which keeps its separator. */
function isBareRoot(value: string): boolean {
  return value.length === 1 ? isSeparator(value) : DRIVE_ROOT_PATTERN.test(value);
}

/** Drops trailing `/` and `\`, except the one of a bare root. */
export function stripTrailingSeparators(value: string): string {
  let end = value.length;

  while (end > 1 && isSeparator(value[end - 1]) && !isBareRoot(value.slice(0, end))) {
    end -= 1;
  }

  return value.slice(0, end);
}

/** `value` up to `cut`, keeping the separator of a bare root (`/x`, `C:\x`). */
function cutAt(value: string, cut: number): string {
  return cut < value.length && isBareRoot(value.slice(0, cut + 1))
    ? value.slice(0, cut + 1)
    : value.slice(0, cut);
}

/** The directory above the first `node_modules` segment, or `value` without one. */
function stripDependencyPath(value: string): string {
  let cut = value.length;

  for (const separator of ['/', '\\']) {
    const needle = `${separator}node_modules`;

    for (let index = value.indexOf(needle); index >= 0; index = value.indexOf(needle, index + 1)) {
      const end = index + needle.length;

      if (end === value.length || isSeparator(value[end])) {
        cut = Math.min(cut, index);
        break;
      }
    }
  }

  // `/node_modules/x` and `C:\node_modules\x` keep their root's separator.
  return cutAt(value, cut);
}

/**
 * The repository above the first Claude Code worktree (`<repo>/.claude/worktrees/<name>`,
 * or a directory inside one), or `value` without one.
 */
function stripClaudeWorktreePath(value: string): string {
  for (const separator of ['/', '\\']) {
    const needle = `${separator}.claude${separator}worktrees${separator}`;
    const index = value.indexOf(needle);
    const name = index + needle.length;

    if (index >= 0 && name < value.length && !isSeparator(value[name])) {
      return cutAt(value, index);
    }
  }

  return value;
}

/**
 * The project key of an event: its `repoRoot` without trailing separators. A directory
 * inside `node_modules`, where a session can `cd` into a dependency, counts as the project
 * that holds it, and a Claude Code worktree counts as the repository it belongs to.
 */
export function toProjectKey(repoRoot: string | undefined): string | undefined {
  return repoRoot === undefined
    ? undefined
    : stripTrailingSeparators(
        stripClaudeWorktreePath(stripDependencyPath(stripTrailingSeparators(repoRoot))),
      );
}

/** The label `labels` gives the event's project; `(unattributed)` without one. */
export function toProjectLabel(
  repoRoot: string | undefined,
  labels: ReadonlyMap<string | undefined, string>,
): string {
  return labels.get(toProjectKey(repoRoot)) ?? UNATTRIBUTED_PROJECT_LABEL;
}

/** Path segments of a key, without a drive letter, which belongs to the root. */
export function splitKeySegments(key: string): string[] {
  return key
    .replace(DRIVE_PREFIX_PATTERN, '')
    .split(/[\\/]/u)
    .filter((segment) => segment.length > 0);
}

type PendingKey = { segments: string[]; depth: number };

/**
 * Display labels for project keys: the last path segment, extended with parent segments
 * until no other key and no label already given shares it. A key that runs out of segments
 * while it still collides is labelled with the full key, numbered ` #2`, ` #3`… if that
 * is taken too. `undefined` (no repository root) is `(unattributed)`, a label no real
 * project gets.
 *
 * Call it once per report over every key in its filtered events, so a project keeps one
 * label across periods and windows.
 */
export function buildProjectLabels(
  keys: Iterable<string | undefined>,
): Map<string | undefined, string> {
  const labels = new Map<string | undefined, string>();
  const pending = new Map<string, PendingKey>();
  // Labels given so far; the reserved one is never given to a real project.
  const taken = new Set([UNATTRIBUTED_PROJECT_LABEL]);
  const give = (key: string, label: string) => {
    labels.set(key, label);
    taken.add(label);
    pending.delete(key);
  };

  for (const key of keys) {
    if (key === undefined) {
      labels.set(undefined, UNATTRIBUTED_PROJECT_LABEL);
    } else if (!pending.has(key)) {
      pending.set(key, { segments: splitKeySegments(key), depth: 1 });
    }
  }

  while (pending.size > 0) {
    const keysByLabel = new Map<string, [string, PendingKey][]>();
    const outOfSegments: string[] = [];

    for (const [key, entry] of pending) {
      const { segments, depth } = entry;
      const label = depth > segments.length ? key : segments.slice(-depth).join('/');
      keysByLabel.set(label, [...(keysByLabel.get(label) ?? []), [key, entry]]);
    }

    for (const [label, labelKeys] of keysByLabel) {
      if (labelKeys.length === 1 && !taken.has(label)) {
        give(labelKeys[0][0], label);
        continue;
      }

      for (const [key, entry] of labelKeys) {
        if (entry.depth >= entry.segments.length) {
          outOfSegments.push(key);
        } else {
          entry.depth += 1;
        }
      }
    }

    // Out of segments while still colliding: the full key, which a rootless key spelled like
    // the reserved label reads as a relative path, numbered if even that is taken. Sorted, so
    // the numbers do not depend on the input order.
    for (const key of outOfSegments.sort(compareByCodePoint)) {
      const label = key === UNATTRIBUTED_PROJECT_LABEL ? `./${key}` : key;
      let numbered = label;

      for (let number = 2; taken.has(numbered); number += 1) {
        numbered = `${label} #${String(number)}`;
      }

      give(key, numbered);
    }
  }

  return labels;
}

/** Project labels for every repository root in a report's events (see `buildProjectLabels`). */
export function buildEventProjectLabels(
  events: Iterable<{ repoRoot?: string }>,
): Map<string | undefined, string> {
  const keys: (string | undefined)[] = [];

  for (const event of events) {
    keys.push(toProjectKey(event.repoRoot));
  }

  return buildProjectLabels(keys);
}
