import { readdirSync } from 'node:fs';
import path from 'node:path';

import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import { readEnvPath, type SourceContext } from '../source-context.js';

const CHANNEL_DB_FILE_PATTERN = /^opencode-.+\.db$/u;

function deduplicate(paths: string[]): string[] {
  return [...new Set(paths)];
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

function getLinuxLikeCandidates(context: SourceContext): string[] {
  const { homeDir } = context;
  const xdgDataHome =
    readEnvPath(context, 'XDG_DATA_HOME') ?? path.join(homeDir, '.local', 'share');

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

function getWindowsCandidates(context: SourceContext): string[] {
  const { homeDir } = context;
  const userProfile = readEnvPath(context, 'USERPROFILE');
  const roamingBase =
    readEnvPath(context, 'APPDATA') ??
    readEnvPath(context, 'LOCALAPPDATA') ??
    (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : undefined);

  const roamingCandidates = roamingBase
    ? getDirectoryCandidates(path.join(roamingBase, 'opencode'))
    : [];

  return [...roamingCandidates, ...getDirectoryCandidates(path.join(homeDir, '.opencode'))];
}

export function getDefaultOpenCodeDbPathCandidates(context: SourceContext): string[] {
  switch (context.platform) {
    case 'win32':
      return deduplicate(getWindowsCandidates(context));
    case 'darwin':
      return deduplicate(getMacOsCandidates(context.homeDir));
    default:
      return deduplicate(getLinuxLikeCandidates(context));
  }
}
