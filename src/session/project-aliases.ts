import {
  isWindowsProjectKey,
  toComparableProjectKey,
  toParentProjectKey,
} from '../aggregate/project-key.js';
import type { ProjectAlias } from '../config/user-config.js';

/**
 * Where `projectAliases` moves a project key: the nearest alias at or above it is replaced
 * by its target, keeping the path below it (`~/work/Orange/api` -> `~/projects/orange/api`).
 * Undefined when no alias holds the key, or a target is nearer than any alias: usage at or
 * below a target stays, so aliases do not chain and a target inside an alias keeps its own.
 */
export function createProjectAliasResolver(
  projectAliases: readonly ProjectAlias[],
): (key: string) => string | undefined {
  const comparable = toComparableProjectKey;
  const targets = new Map<string, string>();
  const targetKeys = new Set<string>();

  for (const { path: target, aliases } of projectAliases) {
    targetKeys.add(comparable(target));

    for (const alias of aliases) {
      // The first listing wins, as the config loader warns.
      if (!targets.has(comparable(alias))) {
        targets.set(comparable(alias), target);
      }
    }
  }

  return (key) => {
    for (let ancestor: string | undefined = key; ancestor !== undefined;) {
      const comparableAncestor = comparable(ancestor);

      if (targetKeys.has(comparableAncestor)) {
        return undefined;
      }

      const target = targets.get(comparableAncestor);

      if (target !== undefined) {
        // The path below the alias in the target's separators: it may be another OS's.
        const separator = isWindowsProjectKey(target) ? '\\' : '/';
        return target + key.slice(ancestor.length).replace(/[\\/]/gu, separator);
      }

      ancestor = toParentProjectKey(ancestor);
    }

    return undefined;
  };
}
