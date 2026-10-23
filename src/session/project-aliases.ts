import { toParentProjectKey, toProjectKey } from '../aggregate/project-key.js';
import type { ProjectAlias } from '../config/user-config.js';

/**
 * Where `projectAliases` moves a project key: the nearest alias at or above it is replaced
 * by its target, keeping the path below it (`~/work/Orange/api` -> `~/projects/orange/api`).
 * Undefined when no alias holds the key. A target is never moved further, so aliases do not
 * chain.
 */
export function createProjectAliasResolver(
  projectAliases: readonly ProjectAlias[],
  platform: NodeJS.Platform = process.platform,
): (key: string) => string | undefined {
  // Windows paths ignore case and take either separator.
  const comparable = (value: string): string =>
    platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value;
  const targets = new Map<string, string>();

  for (const { path: target, aliases } of projectAliases) {
    const targetKey = toProjectKey(target) ?? target;

    for (const alias of aliases) {
      const aliasKey = comparable(toProjectKey(alias) ?? alias);

      // The first listing wins, as the config loader warns.
      if (!targets.has(aliasKey)) {
        targets.set(aliasKey, targetKey);
      }
    }
  }

  return (key) => {
    for (let ancestor: string | undefined = key; ancestor !== undefined;) {
      const target = targets.get(comparable(ancestor));

      if (target !== undefined) {
        return target + key.slice(ancestor.length);
      }

      ancestor = toParentProjectKey(ancestor);
    }

    return undefined;
  };
}
