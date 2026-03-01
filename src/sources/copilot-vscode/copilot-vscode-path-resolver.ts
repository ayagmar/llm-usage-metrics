import os from 'node:os';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import { pathIsDirectory, pathIsFile, pathReadable } from '../../utils/fs-helpers.js';
import { isBlankText } from '../parsing-utils.js';

export type CopilotVscodePathResolverOptions = {
  workspaceStorageDir?: string;
  requireWorkspaceStorageDir?: boolean;
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
};

function deduplicatePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function getLinuxWorkspaceStorageRoots(homeDir: string): string[] {
  return [
    path.join(homeDir, '.config', 'Code', 'User', 'workspaceStorage'),
    path.join(homeDir, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
  ];
}

function getMacWorkspaceStorageRoots(homeDir: string): string[] {
  const appSupport = path.join(homeDir, 'Library', 'Application Support');

  return [
    path.join(appSupport, 'Code', 'User', 'workspaceStorage'),
    path.join(appSupport, 'Code - Insiders', 'User', 'workspaceStorage'),
  ];
}

function getWindowsWorkspaceStorageRoots(homeDir: string, env: NodeJS.ProcessEnv): string[] {
  const roamingBase =
    env.APPDATA ??
    env.LOCALAPPDATA ??
    (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming') : undefined);

  const roamingRoots = roamingBase
    ? [
        path.join(roamingBase, 'Code', 'User', 'workspaceStorage'),
        path.join(roamingBase, 'Code - Insiders', 'User', 'workspaceStorage'),
      ]
    : [];

  return [...roamingRoots, ...getLinuxWorkspaceStorageRoots(homeDir)];
}

export function getDefaultCopilotVscodeWorkspaceStorageRoots(
  options: Pick<CopilotVscodePathResolverOptions, 'platform' | 'homeDir' | 'env'> = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;

  switch (platform) {
    case 'win32':
      return deduplicatePaths(getWindowsWorkspaceStorageRoots(homeDir, env));
    case 'darwin':
      return deduplicatePaths(getMacWorkspaceStorageRoots(homeDir));
    default:
      return deduplicatePaths(getLinuxWorkspaceStorageRoots(homeDir));
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT',
  );
}

async function discoverChatSessionFilesInRoot(workspaceStorageRoot: string): Promise<string[]> {
  let workspaceEntries: Dirent[];

  try {
    workspaceEntries = await readdir(workspaceStorageRoot, {
      withFileTypes: true,
      encoding: 'utf8',
    });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }

    return [];
  }

  workspaceEntries.sort((left, right) => compareByCodePoint(left.name, right.name));

  const files: string[] = [];

  for (const workspaceEntry of workspaceEntries) {
    if (!workspaceEntry.isDirectory()) {
      continue;
    }

    const chatSessionsDir = path.join(workspaceStorageRoot, workspaceEntry.name, 'chatSessions');

    if (!(await pathIsDirectory(chatSessionsDir))) {
      continue;
    }

    let chatSessionEntries: Dirent[];

    try {
      chatSessionEntries = await readdir(chatSessionsDir, {
        withFileTypes: true,
        encoding: 'utf8',
      });
    } catch {
      continue;
    }

    chatSessionEntries.sort((left, right) => compareByCodePoint(left.name, right.name));

    for (const chatSessionEntry of chatSessionEntries) {
      if (!chatSessionEntry.isFile() || !chatSessionEntry.name.toLowerCase().endsWith('.json')) {
        continue;
      }

      const sessionPath = path.join(chatSessionsDir, chatSessionEntry.name);

      if (await pathIsFile(sessionPath)) {
        files.push(sessionPath);
      }
    }
  }

  return files;
}

export async function discoverCopilotVscodeSessionFiles(
  options: CopilotVscodePathResolverOptions = {},
): Promise<string[]> {
  const explicitWorkspaceStorageDir = options.workspaceStorageDir;
  const requireWorkspaceStorageDir = options.requireWorkspaceStorageDir ?? false;

  if (explicitWorkspaceStorageDir !== undefined) {
    if (isBlankText(explicitWorkspaceStorageDir)) {
      throw new Error('Copilot VS Code workspaceStorage directory must be a non-empty path');
    }

    const normalizedRoot = explicitWorkspaceStorageDir.trim();

    if (requireWorkspaceStorageDir && !(await pathReadable(normalizedRoot))) {
      throw new Error(
        `Copilot VS Code workspaceStorage directory is missing or unreadable: ${normalizedRoot}`,
      );
    }

    if (requireWorkspaceStorageDir && !(await pathIsDirectory(normalizedRoot))) {
      throw new Error(
        `Copilot VS Code workspaceStorage directory is not a directory: ${normalizedRoot}`,
      );
    }

    const explicitFiles = await discoverChatSessionFilesInRoot(normalizedRoot);
    explicitFiles.sort(compareByCodePoint);
    return explicitFiles;
  }

  const defaultRoots = getDefaultCopilotVscodeWorkspaceStorageRoots(options);
  const discoveredFiles = new Set<string>();

  for (const root of defaultRoots) {
    if (!(await pathIsDirectory(root))) {
      continue;
    }

    const rootFiles = await discoverChatSessionFilesInRoot(root);

    for (const filePath of rootFiles) {
      discoveredFiles.add(filePath);
    }
  }

  return [...discoveredFiles].sort(compareByCodePoint);
}
