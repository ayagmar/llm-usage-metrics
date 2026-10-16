import { buildProjectLabels, UNATTRIBUTED_PROJECT_LABEL } from '../aggregate/project-key.js';
import { LOCAL_MACHINE_NAME } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';

/** The model label of usage that names no model. */
export const UNKNOWN_MODEL_LABEL = '(unknown)';

/** The label of a project whose root is a bare `/`, `\` or drive root. */
const ROOT_PROJECT_LABEL = '(root)';

const DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;

/** Whether `value` reads as a path: `/…`, `~…`, `X:\…` (or `X:/…`), `\\…`. */
export function isPathLike(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.startsWith('\\\\') ||
    DRIVE_PATH_PATTERN.test(value)
  );
}

/** The last segment of a path, ignoring trailing separators; the value itself when it has none. */
export function toBasename(value: string): string {
  const segments = value.split(/[\\/]/u).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? value;
}

/** A model as the share report shows it: path-like names become their basename. */
export function toShareModelLabel(model: string | undefined): string {
  const normalized = model?.trim().toLowerCase();

  if (!normalized) {
    return UNKNOWN_MODEL_LABEL;
  }

  return isPathLike(normalized) ? toBasename(normalized) : normalized;
}

function splitKeySegments(key: string): string[] {
  return key
    .replace(/^[A-Za-z]:/u, '')
    .split(/[\\/]/u)
    .filter((segment) => segment.length > 0);
}

/** Whether `buildProjectLabels` gave `key` a tail of its own segments rather than the full key. */
function isSegmentTail(key: string, label: string): boolean {
  const segments = splitKeySegments(key);

  for (let depth = 1; depth <= segments.length; depth += 1) {
    if (segments.slice(-depth).join('/') === label) {
      return true;
    }
  }

  return false;
}

/**
 * Project labels as `buildProjectLabels` gives them, except that keys it could only tell apart
 * by their full path get their deepest segment tail numbered ` #2`, ` #3`… instead, so no label
 * is ever a full path (two drives holding the same folders, for example).
 */
export function buildShareProjectLabels(
  keys: Iterable<string | undefined>,
): Map<string | undefined, string> {
  const labels = buildProjectLabels(keys);
  const taken = new Set<string>();
  const fullPathKeys: string[] = [];

  for (const [key, label] of labels) {
    if (key === undefined || isSegmentTail(key, label)) {
      taken.add(label);
    } else {
      fullPathKeys.push(key);
    }
  }

  for (const key of fullPathKeys.sort(compareByCodePoint)) {
    const tail = splitKeySegments(key).join('/');
    // A bare root has no segment; a rootless key may be spelled like the reserved label.
    const base =
      tail === '' ? ROOT_PROJECT_LABEL : tail === UNATTRIBUTED_PROJECT_LABEL ? `./${tail}` : tail;
    let label = base;

    for (let number = 2; taken.has(label); number += 1) {
      label = `${base} #${String(number)}`;
    }

    labels.set(key, label);
    taken.add(label);
  }

  return labels;
}

/**
 * Stand-in names for `--redact`: `<prefix>-1…n` by tokens, most first, ties by the original
 * label. `keep` labels (such as `local` or `(unattributed)`) name no one and stay as they are.
 */
export function buildRedactionMap(
  tokensByLabel: ReadonlyMap<string, number>,
  prefix: string,
  keep: ReadonlySet<string>,
): Map<string, string> {
  const ranked = [...tokensByLabel.entries()]
    .filter(([label]) => !keep.has(label))
    .sort(([leftLabel, leftTokens], [rightLabel, rightTokens]) =>
      leftTokens === rightTokens
        ? compareByCodePoint(leftLabel, rightLabel)
        : rightTokens - leftTokens,
    );
  const redacted = new Map<string, string>();

  for (const label of keep) {
    if (tokensByLabel.has(label)) {
      redacted.set(label, label);
    }
  }

  ranked.forEach(([label], index) => {
    redacted.set(label, `${prefix}-${String(index + 1)}`);
  });

  return redacted;
}

export const KEPT_PROJECT_LABELS: ReadonlySet<string> = new Set([UNATTRIBUTED_PROJECT_LABEL]);
export const KEPT_MACHINE_LABELS: ReadonlySet<string> = new Set([LOCAL_MACHINE_NAME]);

/**
 * Removes paths from free text: each known path (longest first) becomes its replacement, and a
 * value that is a path as a whole becomes its basename.
 */
export function createPathScrubber(
  replacements: ReadonlyMap<string, string>,
): (value: string) => string {
  const ordered = [...replacements.entries()]
    .filter(([path]) => path.length > 0)
    .sort(([left], [right]) => right.length - left.length || compareByCodePoint(left, right));

  return (value) => {
    let scrubbed = value;

    for (const [path, replacement] of ordered) {
      if (scrubbed.includes(path)) {
        scrubbed = scrubbed.split(path).join(replacement);
      }
    }

    return isPathLike(scrubbed) ? toBasename(scrubbed) : scrubbed;
  };
}
