import path from 'node:path';

import type { SourceId, UsageEvent } from '../../domain/usage-event.js';
import { discoverFiles } from '../../utils/discover-files.js';
import { discoverFilesAcrossRoots, resolveRootDirs } from '../multi-root-discovery.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceReadOptions,
} from '../source-adapter.js';
import { createSourceContext, readEnvPath, type SourceContext } from '../source-context.js';
import { getClineTaskHistoryPath, readClineTaskFile } from './cline-task-parser.js';

/** The VS Code extension id of each Cline-family source, which names its storage directory. */
export const CLINE_EXTENSION_IDS = {
  cline: 'saoudrizwan.claude-dev',
  roocode: 'rooveterinaryinc.roo-cline',
  kilocode: 'kilocode.kilo-code',
} as const;

export type ClineFamilySourceId = keyof typeof CLINE_EXTENSION_IDS;

export type ClineTaskRootResolverOptions = {
  extensionId: string;
  context: SourceContext;
};

/** Options for `createClineFamilyAdapter`. */
export type ClineFamilyAdapterOptions = SourceAdapterPathOptions & {
  /** `cline`, `roocode` or `kilocode`. */
  id: ClineFamilySourceId;
  /** The extension whose task storage to read, usually `CLINE_EXTENSION_IDS[id]`. */
  extensionId: string;
  /** Test seam: default roots scanned when no dir override is given. @internal */
  defaultRootDirs?: string[];
};

function getExtensionTasksDir(codeRoot: string, extensionId: string): string {
  return path.join(codeRoot, 'User', 'globalStorage', extensionId, 'tasks');
}

/** Editors whose user data dirs hold Cline-family storage, named as their app data folder. */
const EDITOR_APP_DIRS = ['Code', 'Cursor'] as const;

function getWindowsAppDataRoot(context: SourceContext): string {
  const appDataRoot =
    readEnvPath(context, 'APPDATA') ??
    readEnvPath(context, 'USERPROFILE') ??
    path.join(context.homeDir, 'AppData', 'Roaming');

  // An APPDATA that already points at VS Code's own dir stands for its parent.
  if (appDataRoot.endsWith(`${path.sep}Code`) || path.basename(appDataRoot) === 'Code') {
    return path.dirname(appDataRoot);
  }

  return appDataRoot;
}

function getPlatformAppDataRoot(context: SourceContext): string {
  switch (context.platform) {
    case 'win32':
      return getWindowsAppDataRoot(context);
    case 'darwin':
      return path.join(context.homeDir, 'Library', 'Application Support');
    default:
      return path.join(context.homeDir, '.config');
  }
}

export function getDefaultClineTaskRootCandidates(options: ClineTaskRootResolverOptions): string[] {
  const appDataRoot = getPlatformAppDataRoot(options.context);
  const localRoots = EDITOR_APP_DIRS.map((appDir) => path.join(appDataRoot, appDir));
  const remoteRoots = [path.join(options.context.homeDir, '.vscode-server', 'data')];
  const tasksDirs = [...localRoots, ...remoteRoots].map((root) =>
    getExtensionTasksDir(root, options.extensionId),
  );

  return [...new Set(tasksDirs)];
}

async function discoverUiMessageFiles(rootDir: string): Promise<string[]> {
  const jsonFiles = await discoverFiles(rootDir, { extension: '.json' });
  return jsonFiles.filter((filePath) => path.basename(filePath) === 'ui_messages.json');
}

/**
 * Cline, Roo Code or Kilo Code tasks (`ui_messages.json`, with the model from
 * `api_conversation_history.json`), from the extension's global storage in VS Code and Cursor,
 * and in `~/.vscode-server`.
 */
export class ClineFamilyAdapter implements SourceAdapter {
  public readonly id: SourceId;
  public readonly parserVersion = 3;
  public readonly capabilities = { eventsPrecedeFileMtime: true, kinds: ['usage'] } as const;

  private readonly rootDirs: readonly string[];
  private readonly requireDir: boolean;

  public constructor(options: ClineFamilyAdapterOptions) {
    this.id = options.id;
    this.rootDirs = resolveRootDirs(
      options.dir,
      options.defaultRootDirs ??
        getDefaultClineTaskRootCandidates({
          extensionId: options.extensionId,
          context: options.context ?? createSourceContext(),
        }),
    );
    this.requireDir = options.requireDir ?? false;
  }

  public getSearchPaths(): string[] {
    return this.rootDirs.map((searchPath) => searchPath.trim());
  }

  public async discoverFiles(): Promise<string[]> {
    return discoverFilesAcrossRoots({
      rootDirs: this.rootDirs,
      requireDir: this.requireDir,
      directoryLabel: `${this.id} tasks directory`,
      discoverInRoot: (rootDir) => discoverUiMessageFiles(rootDir),
      sortAcrossRoots: true,
    });
  }

  public async getParseDependencies(filePath: string): Promise<string[]> {
    return [getClineTaskHistoryPath(filePath)];
  }

  public read(filePath: string, options?: SourceReadOptions): AsyncGenerator<UsageEvent> {
    return readClineTaskFile(this.id, filePath, options);
  }
}

/** Builds the adapter for one Cline-family source. */
export function createClineFamilyAdapter(options: ClineFamilyAdapterOptions): ClineFamilyAdapter {
  return new ClineFamilyAdapter(options);
}
