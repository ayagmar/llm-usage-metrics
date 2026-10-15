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

/** The project key of an event: its raw `repoRoot` without trailing separators. */
export function toProjectKey(repoRoot: string | undefined): string | undefined {
  return repoRoot === undefined ? undefined : stripTrailingSeparators(repoRoot);
}

/** Path segments of a key, without a drive letter, which belongs to the root. */
function splitKeySegments(key: string): string[] {
  return key
    .replace(DRIVE_PREFIX_PATTERN, '')
    .split(/[\\/]/u)
    .filter((segment) => segment.length > 0);
}

/**
 * Display labels for project keys: the last path segment, extended with parent segments
 * until it is unique. A key that runs out of segments while it still collides is labelled
 * with the full key. `undefined` (no repository root) is `(unattributed)`.
 *
 * Call it once per report over every key in its filtered events, so a project keeps one
 * label across periods and windows.
 */
export function buildProjectLabels(
  keys: Iterable<string | undefined>,
): Map<string | undefined, string> {
  const labels = new Map<string | undefined, string>();
  const pending = new Map<string, { segments: string[]; depth: number }>();

  for (const key of keys) {
    if (key === undefined) {
      labels.set(undefined, UNATTRIBUTED_PROJECT_LABEL);
    } else if (!pending.has(key)) {
      pending.set(key, { segments: splitKeySegments(key), depth: 1 });
    }
  }

  while (pending.size > 0) {
    const keysByLabel = new Map<string, string[]>();

    for (const [key, { segments, depth }] of pending) {
      const label = depth > segments.length ? key : segments.slice(-depth).join('/');
      keysByLabel.set(label, [...(keysByLabel.get(label) ?? []), key]);
    }

    for (const [label, labelKeys] of keysByLabel) {
      for (const key of labelKeys) {
        const entry = pending.get(key);

        if (!entry) {
          continue;
        }

        if (labelKeys.length === 1) {
          labels.set(key, label);
          pending.delete(key);
        } else if (entry.depth >= entry.segments.length) {
          // Out of segments while still colliding: only the full key is unambiguous.
          labels.set(key, key);
          pending.delete(key);
        } else {
          entry.depth += 1;
        }
      }
    }
  }

  return labels;
}
