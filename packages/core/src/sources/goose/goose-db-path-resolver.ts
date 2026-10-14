import path from 'node:path';

import { readEnvPath, type SourceContext } from '../source-context.js';

function deduplicate(paths: string[]): string[] {
  return [...new Set(paths)];
}

function getGooseDbPath(rootDir: string): string {
  return path.join(rootDir, 'goose', 'sessions', 'sessions.db');
}

function getLinuxLikeCandidates(context: SourceContext): string[] {
  const { homeDir } = context;
  const xdgDataHome =
    readEnvPath(context, 'XDG_DATA_HOME') ?? path.join(homeDir, '.local', 'share');

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

function getWindowsCandidates(context: SourceContext): string[] {
  const { homeDir } = context;
  const userProfile = readEnvPath(context, 'USERPROFILE');
  const roamingBase =
    readEnvPath(context, 'APPDATA') ??
    readEnvPath(context, 'LOCALAPPDATA') ??
    (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : undefined);
  const roamingCandidates = roamingBase ? [getGooseDbPath(roamingBase)] : [];

  return [
    ...roamingCandidates,
    path.join(homeDir, '.local', 'share', 'Block', 'goose', 'sessions', 'sessions.db'),
  ];
}

export function getDefaultGooseDbPathCandidates(context: SourceContext): string[] {
  const goosePathRoot = readEnvPath(context, 'GOOSE_PATH_ROOT');
  const envCandidates = goosePathRoot
    ? [path.join(goosePathRoot, 'data', 'sessions', 'sessions.db')]
    : [];

  switch (context.platform) {
    case 'win32':
      return deduplicate([...envCandidates, ...getWindowsCandidates(context)]);
    case 'darwin':
      return deduplicate([...envCandidates, ...getMacOsCandidates(context.homeDir)]);
    default:
      return deduplicate([...envCandidates, ...getLinuxLikeCandidates(context)]);
  }
}
