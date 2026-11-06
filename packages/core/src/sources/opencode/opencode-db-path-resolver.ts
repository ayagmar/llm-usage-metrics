import { readdirSync } from 'node:fs';
import path from 'node:path';

import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import type { SourceContext } from '../source-context.js';
import {
  deduplicatePaths,
  resolveWindowsRoamingBase,
  resolveXdgDataHome,
} from '../sqlite/sqlite-db-source.js';

const CHANNEL_DB_FILE_PATTERN = /^opencode-.+\.db$/u;
// The pre-release V2 database. OpenCode 2 imports it into opencode.db, so reading it too
// would count its sessions twice.
const PRE_RELEASE_V2_DB_FILE_NAME = 'opencode-next.db';

function listChannelDbFileNames(directory: string): string[] {
  let fileNames: string[];

  try {
    fileNames = readdirSync(directory);
  } catch {
    // Missing or unreadable directory: no channel databases to offer.
    return [];
  }

  return fileNames
    .filter(
      (fileName) =>
        CHANNEL_DB_FILE_PATTERN.test(fileName) && fileName !== PRE_RELEASE_V2_DB_FILE_NAME,
    )
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
  const xdgDataHome = resolveXdgDataHome(context);

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
  const roamingBase = resolveWindowsRoamingBase(context);

  const roamingCandidates = roamingBase
    ? getDirectoryCandidates(path.join(roamingBase, 'opencode'))
    : [];

  return [...roamingCandidates, ...getDirectoryCandidates(path.join(homeDir, '.opencode'))];
}

export function getDefaultOpenCodeDbPathCandidates(context: SourceContext): string[] {
  switch (context.platform) {
    case 'win32':
      return deduplicatePaths(getWindowsCandidates(context));
    case 'darwin':
      return deduplicatePaths(getMacOsCandidates(context.homeDir));
    default:
      return deduplicatePaths(getLinuxLikeCandidates(context));
  }
}
