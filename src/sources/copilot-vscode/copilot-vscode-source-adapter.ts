import { readFile } from 'node:fs/promises';

import type { UsageEvent } from '../../domain/usage-event.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../source-adapter.js';
import {
  discoverCopilotVscodeSessionFiles,
  type CopilotVscodePathResolverOptions,
} from './copilot-vscode-path-resolver.js';
import { parseCopilotVscodeSession } from './copilot-vscode-session-parser.js';

export type CopilotVscodeSourceAdapterOptions = CopilotVscodePathResolverOptions;

export class CopilotVscodeSourceAdapter implements SourceAdapter {
  public readonly id = 'copilot-vscode' as const;

  private readonly workspaceStorageDir: string | undefined;
  private readonly requireWorkspaceStorageDir: boolean;
  private readonly pathResolverOptions: Pick<
    CopilotVscodePathResolverOptions,
    'platform' | 'homeDir' | 'env'
  >;

  public constructor(options: CopilotVscodeSourceAdapterOptions = {}) {
    this.workspaceStorageDir = options.workspaceStorageDir;
    this.requireWorkspaceStorageDir = options.requireWorkspaceStorageDir ?? false;
    this.pathResolverOptions = {
      platform: options.platform,
      homeDir: options.homeDir,
      env: options.env,
    };
  }

  public async discoverFiles(): Promise<string[]> {
    return discoverCopilotVscodeSessionFiles({
      workspaceStorageDir: this.workspaceStorageDir,
      requireWorkspaceStorageDir: this.requireWorkspaceStorageDir,
      ...this.pathResolverOptions,
    });
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);
    return events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const content = await readFile(filePath, 'utf8');
    return parseCopilotVscodeSession(filePath, content);
  }
}
