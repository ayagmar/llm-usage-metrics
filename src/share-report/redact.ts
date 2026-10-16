import {
  buildProjectLabels,
  stripTrailingSeparators,
  UNATTRIBUTED_PROJECT_LABEL,
} from '../aggregate/project-key.js';
import { LOCAL_MACHINE_NAME } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';

/** The model label of usage that names no model. */
export const UNKNOWN_MODEL_LABEL = '(unknown)';

/** The label of a project whose root is a bare `/`, `\` or drive root. */
const ROOT_PROJECT_LABEL = '(root)';

const DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const FILE_URI_PATTERN = /^file:/iu;
const RELATIVE_PATH_PATTERN = /^\.{1,2}[\\/]/u;

/** Whether `value` reads as a path: `/…`, `~…`, `X:\…`, `X:/…`, `\\…`, `file:…`, `./…`, `../…`. */
export function isPathLike(value: string): boolean {
  return (
    value.startsWith('/') ||
    FILE_URI_PATTERN.test(value) ||
    value.startsWith('~') ||
    value.startsWith('\\\\') ||
    DRIVE_PATH_PATTERN.test(value) ||
    RELATIVE_PATH_PATTERN.test(value)
  );
}

/** The last segment of a path, ignoring trailing separators; the value itself when it has none. */
export function toBasename(value: string): string {
  const segments = value.split(/[\\/]/u).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? value;
}

/** A path as one name: its basename, or `~` for a home directory, whose name is the user's. */
function toPathName(value: string): string {
  const homeEnd = getHomeEnd(value, undefined);
  return homeEnd !== undefined && splitKeySegments(value.slice(homeEnd)).length === 0
    ? '~'
    : toBasename(value);
}

/**
 * A model as the share report shows it: path-like names, and any holding a standard home
 * directory, become their basename.
 */
export function toShareModelLabel(model: string | undefined): string {
  const normalized = model?.trim().toLowerCase();

  if (!normalized) {
    return UNKNOWN_MODEL_LABEL;
  }

  return isPathLike(normalized) || STANDARD_HOME_PATTERN.test(normalized)
    ? toPathName(normalized)
    : normalized;
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

/** Where a standard home layout starts: `…/home/`, `…/Users/` (either separator, any case). */
const HOME_ROOT_SOURCE = String.raw`[\\/](?:home|users)[\\/]`;

/**
 * A home directory by its standard layout, anywhere in a path: `…/home/<name>` (so
 * `/var/home`, `/usr/home` and `/export/home` too), `…/Users/<name>` (`<drive>:\Users` and
 * WSL's `/mnt/<drive>/Users` too) and `/root`, either separator, any case. Events from other
 * machines carry their own home, never the local one.
 */
const STANDARD_HOME_PATTERN = new RegExp(
  String.raw`${HOME_ROOT_SOURCE}[^\\/]+|[\\/]root(?=[\\/]|$)`,
  'iu',
);

/**
 * A standard home directory anywhere in free text (see `STANDARD_HOME_PATTERN`). A name ends
 * at a space or punctuation, except in `\Users\<name>\`, where Windows names may hold spaces.
 */
const STANDARD_HOME_IN_TEXT_PATTERN = new RegExp(
  String.raw`(?:\b[a-z]:|\/mnt\/[a-z]|\/(?:var|usr|export))?(?:\\users\\[^\\/\r\n"'\x60<>:|?*]+(?=\\)|${HOME_ROOT_SOURCE}[^\s\\/"'\x60,;:()[\]{}<>]+)|[\\/]root(?=[\\/\s]|$)`,
  'giu',
);

/** Where the home directory in `key` ends, if it has one: the local one, else a standard one. */
function getHomeEnd(key: string, homeDir: string | undefined): number | undefined {
  const home = homeDir === undefined ? '' : stripTrailingSeparators(homeDir);
  const next = key.charAt(home.length);

  // A home at a bare root (or none) would turn every path into `~/…` without hiding a name.
  if (
    splitKeySegments(home).length > 0 &&
    key.startsWith(home) &&
    (next === '' || next === '/' || next === '\\')
  ) {
    return home.length;
  }

  const match = STANDARD_HOME_PATTERN.exec(key);
  return match === null ? undefined : match.index + match[0].length;
}

/**
 * A key with its home directory spelled `~` (and `/` as the separator after it), so no label
 * can climb into or past a home directory, whose name is usually the user's.
 */
function toHomeRelativeKey(key: string, homeDir: string | undefined): string {
  const end = getHomeEnd(key, homeDir);

  if (end === undefined) {
    return key;
  }

  const rest = splitKeySegments(key.slice(end));
  return rest.length === 0 ? '~' : `~/${rest.join('/')}`;
}

/**
 * Project labels as `buildProjectLabels` gives them, with two changes so no label names a
 * path or the user: a home directory (the local one or any standard one) is `~` and roots
 * under it extend no further than `~/…`; and keys it could only tell apart by their full path
 * get their deepest segment tail numbered ` #2`, ` #3`… instead (two drives holding the same
 * folders, for example). Keys equal once spelled that way are numbered too, never merged.
 */
export function buildShareProjectLabels(
  keys: Iterable<string | undefined>,
  homeDir?: string,
): Map<string | undefined, string> {
  const shownKeys = new Map<string | undefined, string | undefined>();

  for (const key of keys) {
    shownKeys.set(key, key === undefined ? undefined : toHomeRelativeKey(key, homeDir));
  }

  const labels = buildProjectLabels(shownKeys.values());
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

  // Keys spelled alike once their home is `~` (two machines' homes, say) stay apart: the
  // first in code-point order keeps the label, the others are numbered.
  const shareLabels = new Map<string | undefined, string>();
  const definedKeys = [...shownKeys.keys()].filter((key) => key !== undefined);
  const labelled = new Set<string | undefined>();

  if (shownKeys.has(undefined)) {
    shareLabels.set(undefined, UNATTRIBUTED_PROJECT_LABEL);
  }

  for (const key of definedKeys.sort(compareByCodePoint)) {
    const shownKey = shownKeys.get(key);
    const base = labels.get(shownKey) ?? UNATTRIBUTED_PROJECT_LABEL;
    let label = base;

    for (let number = 2; labelled.has(shownKey) && taken.has(label); number += 1) {
      label = `${base} #${String(number)}`;
    }

    labelled.add(shownKey);
    taken.add(label);
    shareLabels.set(key, label);
  }

  return shareLabels;
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
 * Removes paths from free text: each known path (longest first) becomes its replacement, any
 * other standard home directory becomes `~`, and a value that is a path as a whole becomes its
 * basename.
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

    // Homes no known path covered: other machines' and other users'.
    scrubbed = scrubbed.replace(STANDARD_HOME_IN_TEXT_PATTERN, '~');

    return isPathLike(scrubbed) ? toPathName(scrubbed) : scrubbed;
  };
}
