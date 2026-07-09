import os from 'node:os';
import path from 'node:path';

import type { SourceId, UsageEvent } from '../../domain/usage-event.js';
import { discoverFiles } from '../../utils/discover-files.js';
import { discoverFilesAcrossRoots, resolveRootDirs } from '../multi-root-discovery.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../source-adapter.js';
import { getClineTaskHistoryPath, parseClineTaskFile } from './cline-task-parser.js';

export const CLINE_EXTENSION_IDS = {
  cline: 'saoudrizwan.claude-dev',
  roocode: 'rooveterinaryinc.roo-cline',
  kilocode: 'kilocode.kilo-code',
} as const;

export type ClineFamilySourceId = keyof typeof CLINE_EXTENSION_IDS;

export type ClineTaskRootResolverOptions = {
  extensionId: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
};

export type ClineFamilyAdapterOptions = {
  id: ClineFamilySourceId;
  extensionId: string;
  tasksDir?: string;
  requireTasksDir?: boolean;
  defaultRootDirs?: string[];
};

function normalizeEnvPath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function getExtensionTasksDir(codeRoot: string, extensionId: string): string {
  return path.join(codeRoot, 'User', 'globalStorage', extensionId, 'tasks');
}

function getWindowsCodeRoot(homeDir: string, env: NodeJS.ProcessEnv): string {
  const appDataRoot =
    normalizeEnvPath(env.APPDATA) ??
    normalizeEnvPath(env.USERPROFILE) ??
    path.join(homeDir, 'AppData', 'Roaming');

  if (appDataRoot.endsWith(`${path.sep}Code`) || path.basename(appDataRoot) === 'Code') {
    return appDataRoot;
  }

  return path.join(appDataRoot, 'Code');
}

function getPlatformCodeRoots(
  platform: NodeJS.Platform,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): string[] {
  switch (platform) {
    case 'win32':
      return [getWindowsCodeRoot(homeDir, env)];
    case 'darwin':
      return [path.join(homeDir, 'Library', 'Application Support', 'Code')];
    default:
      return [path.join(homeDir, '.config', 'Code')];
  }
}

export function getDefaultClineTaskRootCandidates(options: ClineTaskRootResolverOptions): string[] {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const localRoots = getPlatformCodeRoots(platform, homeDir, env);
  const remoteRoots = [path.join(homeDir, '.vscode-server', 'data')];
  const tasksDirs = [...localRoots, ...remoteRoots].map((root) =>
    getExtensionTasksDir(root, options.extensionId),
  );

  return [...new Set(tasksDirs)];
}

async function discoverUiMessageFiles(rootDir: string): Promise<string[]> {
  const jsonFiles = await discoverFiles(rootDir, { extension: '.json' });
  return jsonFiles.filter((filePath) => path.basename(filePath) === 'ui_messages.json');
}

export class ClineFamilyAdapter implements SourceAdapter {
  public readonly id: SourceId;

  private readonly rootDirs: readonly string[];
  private readonly requireTasksDir: boolean;

  public constructor(options: ClineFamilyAdapterOptions) {
    this.id = options.id;
    this.rootDirs = resolveRootDirs(
      options.tasksDir,
      options.defaultRootDirs ??
        getDefaultClineTaskRootCandidates({ extensionId: options.extensionId }),
    );
    this.requireTasksDir = options.requireTasksDir ?? false;
  }

  public async discoverFiles(): Promise<string[]> {
    return discoverFilesAcrossRoots({
      rootDirs: this.rootDirs,
      requireDir: this.requireTasksDir,
      directoryLabel: `${this.id} tasks directory`,
      discoverInRoot: (rootDir) => discoverUiMessageFiles(rootDir),
      sortAcrossRoots: true,
    });
  }

  public async getParseDependencies(filePath: string): Promise<string[]> {
    return [getClineTaskHistoryPath(filePath)];
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);
    return events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    return parseClineTaskFile(this.id, filePath);
  }
}

export function createClineFamilyAdapter(options: ClineFamilyAdapterOptions): ClineFamilyAdapter {
  return new ClineFamilyAdapter(options);
}
