import os from 'node:os';
import path from 'node:path';

export type OpenCodeDbPathResolverOptions = {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
};

function deduplicate(paths: string[]): string[] {
  return [...new Set(paths)];
}

function normalizeEnvPath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function getLinuxLikeCandidates(homeDir: string, env: NodeJS.ProcessEnv): string[] {
  const xdgDataHome = normalizeEnvPath(env.XDG_DATA_HOME) ?? path.join(homeDir, '.local', 'share');

  return [
    path.join(xdgDataHome, 'opencode', 'opencode.db'),
    path.join(xdgDataHome, 'opencode', 'db.sqlite'),
    path.join(homeDir, '.opencode', 'opencode.db'),
    path.join(homeDir, '.opencode', 'db.sqlite'),
  ];
}

function getMacOsCandidates(homeDir: string): string[] {
  const appSupportDir = path.join(homeDir, 'Library', 'Application Support');

  return [
    path.join(appSupportDir, 'opencode', 'opencode.db'),
    path.join(appSupportDir, 'opencode', 'db.sqlite'),
    path.join(homeDir, '.opencode', 'opencode.db'),
    path.join(homeDir, '.opencode', 'db.sqlite'),
  ];
}

function getWindowsCandidates(homeDir: string, env: NodeJS.ProcessEnv): string[] {
  const userProfile = normalizeEnvPath(env.USERPROFILE);
  const roamingBase =
    normalizeEnvPath(env.APPDATA) ??
    normalizeEnvPath(env.LOCALAPPDATA) ??
    (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : undefined);

  const roamingCandidates = roamingBase
    ? [
        path.join(roamingBase, 'opencode', 'opencode.db'),
        path.join(roamingBase, 'opencode', 'db.sqlite'),
      ]
    : [];

  return [
    ...roamingCandidates,
    path.join(homeDir, '.opencode', 'opencode.db'),
    path.join(homeDir, '.opencode', 'db.sqlite'),
  ];
}

export function getDefaultOpenCodeDbPathCandidates(
  options: OpenCodeDbPathResolverOptions = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;

  switch (platform) {
    case 'win32':
      return deduplicate(getWindowsCandidates(homeDir, env));
    case 'darwin':
      return deduplicate(getMacOsCandidates(homeDir));
    default:
      return deduplicate(getLinuxLikeCandidates(homeDir, env));
  }
}
