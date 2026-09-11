import os from 'node:os';
import path from 'node:path';

import { asTrimmedText } from '../parsing-utils.js';

export type DshPathResolverOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

/**
 * DeepSeek Harness keeps every session under `<harness home>/sessions`, where
 * the harness home is `$DSH_HOME` when set and `~/.dsh` otherwise. A blank
 * `$DSH_HOME` is treated as unset, mirroring the harness's own resolution.
 */
function resolveDshHome(options: Required<DshPathResolverOptions>): string {
  const configuredHome = asTrimmedText(options.env.DSH_HOME);

  if (!configuredHome) {
    return path.join(options.homeDir, '.dsh');
  }

  if (configuredHome === '~') {
    return options.homeDir;
  }

  if (configuredHome.startsWith('~/') || configuredHome.startsWith('~\\')) {
    return path.join(options.homeDir, configuredHome.slice(2));
  }

  return configuredHome;
}

export function getDefaultDshSessionsDir(options: DshPathResolverOptions = {}): string {
  const resolvedOptions = {
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? os.homedir(),
  };

  return path.join(resolveDshHome(resolvedOptions), 'sessions');
}
