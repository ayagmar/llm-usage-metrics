import os from 'node:os';
import path from 'node:path';

import type { UsageEvent } from '../../domain/usage-event.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { discoverFilesAcrossRoots, resolveRootDirs } from '../multi-root-discovery.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceParseFileDiagnostics,
} from '../source-adapter.js';
import { parseOpenClawSessionFile } from './openclaw-session-parser.js';

const defaultAgentsDir = path.join(os.homedir(), '.openclaw', 'agents');
const defaultOpenClawRootDirs = [
  defaultAgentsDir,
  path.join(os.homedir(), '.clawdbot', 'agents'),
  path.join(os.homedir(), '.moltbot', 'agents'),
  path.join(os.homedir(), '.moldbot', 'agents'),
];

export type OpenClawSourceAdapterOptions = SourceAdapterPathOptions & {
  /** Test seam: default roots scanned when no dir override is given. */
  defaultRootDirs?: string[];
};

export class OpenClawSourceAdapter implements SourceAdapter {
  public readonly id = 'openclaw' as const;

  private readonly rootDirs: readonly string[];
  private readonly requireDir: boolean;

  public constructor(options: OpenClawSourceAdapterOptions = {}) {
    this.rootDirs = resolveRootDirs(
      options.dir,
      options.defaultRootDirs ?? defaultOpenClawRootDirs,
    );
    this.requireDir = options.requireDir ?? false;
  }

  public async discoverFiles(): Promise<string[]> {
    return discoverFilesAcrossRoots({
      rootDirs: this.rootDirs,
      requireDir: this.requireDir,
      directoryLabel: 'OpenClaw agents directory',
      discoverInRoot: (rootDir) => discoverJsonlFiles(rootDir),
    });
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    return (await this.parseFileWithDiagnostics(filePath)).events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    return parseOpenClawSessionFile(this.id, filePath);
  }
}

export function getDefaultOpenClawAgentsDir(): string {
  return defaultAgentsDir;
}
