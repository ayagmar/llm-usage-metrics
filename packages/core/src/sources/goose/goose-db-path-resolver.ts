import path from 'node:path';

import { readEnvPath, type SourceContext } from '../source-context.js';
import {
  deduplicatePaths,
  resolveWindowsRoamingBase,
  resolveXdgDataHome,
} from '../sqlite/sqlite-db-source.js';

function getGooseDbPath(rootDir: string): string {
  return path.join(rootDir, 'goose', 'sessions', 'sessions.db');
}

function getLinuxLikeCandidates(context: SourceContext): string[] {
  const { homeDir } = context;
  const xdgDataHome = resolveXdgDataHome(context);

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
  const roamingBase = resolveWindowsRoamingBase(context);
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
      return deduplicatePaths([...envCandidates, ...getWindowsCandidates(context)]);
    case 'darwin':
      return deduplicatePaths([...envCandidates, ...getMacOsCandidates(context.homeDir)]);
    default:
      return deduplicatePaths([...envCandidates, ...getLinuxLikeCandidates(context)]);
  }
}
