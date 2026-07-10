import os from 'node:os';
import path from 'node:path';

export type GooseDbPathResolverOptions = {
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

function getGooseDbPath(rootDir: string): string {
  return path.join(rootDir, 'goose', 'sessions', 'sessions.db');
}

function getLinuxLikeCandidates(homeDir: string, env: NodeJS.ProcessEnv): string[] {
  const xdgDataHome = normalizeEnvPath(env.XDG_DATA_HOME) ?? path.join(homeDir, '.local', 'share');

  return [
    getGooseDbPath(xdgDataHome),
    path.join(homeDir, '.local', 'share', 'Block', 'goose', 'sessions', 'sessions.db'),
  ];
}

function getMacOsCandidates(homeDir: string): string[] {
  return [
    path.join(homeDir, 'Library', 'Application Support', 'goose', 'sessions', 'sessions.db'),
    path.join(homeDir, '.local', 'share', 'Block', 'goose', 'sessions', 'sessions.db'),
  ];
}

function getWindowsCandidates(homeDir: string, env: NodeJS.ProcessEnv): string[] {
  const userProfile = normalizeEnvPath(env.USERPROFILE);
  const roamingBase =
    normalizeEnvPath(env.APPDATA) ??
    normalizeEnvPath(env.LOCALAPPDATA) ??
    (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : undefined);
  const roamingCandidates = roamingBase ? [getGooseDbPath(roamingBase)] : [];

  return [
    ...roamingCandidates,
    path.join(homeDir, '.local', 'share', 'Block', 'goose', 'sessions', 'sessions.db'),
  ];
}

export function getDefaultGooseDbPathCandidates(
  options: GooseDbPathResolverOptions = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const goosePathRoot = normalizeEnvPath(env.GOOSE_PATH_ROOT);
  const envCandidates = goosePathRoot
    ? [path.join(goosePathRoot, 'data', 'sessions', 'sessions.db')]
    : [];

  switch (platform) {
    case 'win32':
      return deduplicate([...envCandidates, ...getWindowsCandidates(homeDir, env)]);
    case 'darwin':
      return deduplicate([...envCandidates, ...getMacOsCandidates(homeDir)]);
    default:
      return deduplicate([...envCandidates, ...getLinuxLikeCandidates(homeDir, env)]);
  }
}
