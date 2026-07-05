import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareByCodePoint } from '../../utils/compare-by-code-point.js';

export type OpenCodeDbPathResolverOptions = {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
};

const CHANNEL_DB_FILE_PATTERN = /^opencode-.+\.db$/u;

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

function listChannelDbFileNames(directory: string): string[] {
  let fileNames: string[];

  try {
    fileNames = readdirSync(directory);
  } catch {
    // Missing or unreadable directory: no channel databases to offer.
    return [];
  }

  return fileNames
    .filter((fileName) => CHANNEL_DB_FILE_PATTERN.test(fileName))
    .sort(compareByCodePoint);
}

function getDirectoryCandidates(directory: string): string[] {
  return [
    path.join(directory, 'opencode.db'),
    ...listChannelDbFileNames(directory).map((fileName) => path.join(directory, fileName)),
    path.join(directory, 'db.sqlite'),
  ];
}

function getLinuxLikeCandidates(homeDir: string, env: NodeJS.ProcessEnv): string[] {
  const xdgDataHome = normalizeEnvPath(env.XDG_DATA_HOME) ?? path.join(homeDir, '.local', 'share');

  return [
    ...getDirectoryCandidates(path.join(xdgDataHome, 'opencode')),
    ...getDirectoryCandidates(path.join(homeDir, '.opencode')),
  ];
}

function getMacOsCandidates(homeDir: string): string[] {
  const appSupportDir = path.join(homeDir, 'Library', 'Application Support');

  return [
    ...getDirectoryCandidates(path.join(appSupportDir, 'opencode')),
    ...getDirectoryCandidates(path.join(homeDir, '.opencode')),
  ];
}

function getWindowsCandidates(homeDir: string, env: NodeJS.ProcessEnv): string[] {
  const userProfile = normalizeEnvPath(env.USERPROFILE);
  const roamingBase =
    normalizeEnvPath(env.APPDATA) ??
    normalizeEnvPath(env.LOCALAPPDATA) ??
    (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : undefined);

  const roamingCandidates = roamingBase
    ? getDirectoryCandidates(path.join(roamingBase, 'opencode'))
    : [];

  return [...roamingCandidates, ...getDirectoryCandidates(path.join(homeDir, '.opencode'))];
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
