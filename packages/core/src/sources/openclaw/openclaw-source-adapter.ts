import path from 'node:path';

import type { UsageEvent } from '../../domain/usage-event.js';
import { collectFile } from '../../stream/collect.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { createReadDiagnostics } from '../parse-diagnostics.js';
import { discoverFilesAcrossRoots, resolveRootDirs } from '../multi-root-discovery.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceParseFileDiagnostics,
  SourceReadOptions,
} from '../source-adapter.js';
import { createSourceContext, type SourceContext } from '../source-context.js';
import { readOpenClawSessionFile } from './openclaw-session-parser.js';

export function resolveDefaultOpenClawRootDirs(context: SourceContext): string[] {
  return [
    path.join(context.homeDir, '.openclaw', 'agents'),
    path.join(context.homeDir, '.clawdbot', 'agents'),
    path.join(context.homeDir, '.moltbot', 'agents'),
    path.join(context.homeDir, '.moldbot', 'agents'),
  ];
}

export type OpenClawSourceAdapterOptions = SourceAdapterPathOptions & {
  /** Test seam: default roots scanned when no dir override is given. */
  defaultRootDirs?: string[];
};

export class OpenClawSourceAdapter implements SourceAdapter {
  public readonly id = 'openclaw' as const;
  public readonly parserVersion = 4;
  public readonly capabilities = { eventsPrecedeFileMtime: true } as const;

  private readonly rootDirs: readonly string[];
  private readonly requireDir: boolean;

  public constructor(options: OpenClawSourceAdapterOptions = {}) {
    this.rootDirs = resolveRootDirs(
      options.dir,
      options.defaultRootDirs ??
        resolveDefaultOpenClawRootDirs(options.context ?? createSourceContext()),
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
      directoryLabel: 'OpenClaw agents directory',
      discoverInRoot: (rootDir) => discoverJsonlFiles(rootDir),
    });
  }

  public read(filePath: string, options: SourceReadOptions = {}): AsyncGenerator<UsageEvent> {
    return readOpenClawSessionFile(
      this.id,
      filePath,
      options.diagnostics ?? createReadDiagnostics(),
    );
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    return (await collectFile(this, filePath)).events;
  }

  public parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    return collectFile(this, filePath);
  }
}
