import path from 'node:path';

import { readEnvPath, type SourceContext } from '../source-context.js';

/**
 * DeepSeek Harness keeps every session under `<harness home>/sessions`, where
 * the harness home is `$DSH_HOME` when set and `~/.dsh` otherwise. A blank
 * `$DSH_HOME` is treated as unset, mirroring the harness's own resolution.
 */
function resolveDshHome(context: SourceContext): string {
  const configuredHome = readEnvPath(context, 'DSH_HOME');

  if (!configuredHome) {
    return path.join(context.homeDir, '.dsh');
  }

  if (configuredHome === '~') {
    return context.homeDir;
  }

  if (configuredHome.startsWith('~/') || configuredHome.startsWith('~\\')) {
    return path.join(context.homeDir, configuredHome.slice(2));
  }

  return configuredHome;
}

/** `$DSH_HOME/sessions`, or `~/.dsh/sessions` when `DSH_HOME` is unset or blank. */
export function getDefaultDshSessionsDir(context: SourceContext): string {
  return path.join(resolveDshHome(context), 'sessions');
}
