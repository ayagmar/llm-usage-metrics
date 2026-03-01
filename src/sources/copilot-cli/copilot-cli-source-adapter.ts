import { readFile } from 'node:fs/promises';

import type { UsageEvent } from '../../domain/usage-event.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../source-adapter.js';
import { parseCopilotCliEvents } from './copilot-cli-event-parser.js';
import {
  discoverCopilotCliSessionFiles,
  getDefaultCopilotCliSessionsDir,
  type CopilotCliPathResolverOptions,
} from './copilot-cli-path-resolver.js';
import { loadCopilotCliWorkspaceMetadata } from './copilot-cli-workspace-yaml.js';

export type CopilotCliSourceAdapterOptions = CopilotCliPathResolverOptions;

export class CopilotCliSourceAdapter implements SourceAdapter {
  public readonly id = 'copilot-cli' as const;

  private readonly sessionsDir: string | undefined;
  private readonly requireSessionsDir: boolean;

  public constructor(options: CopilotCliSourceAdapterOptions = {}) {
    this.sessionsDir = options.sessionsDir;
    this.requireSessionsDir = options.requireSessionsDir ?? false;
  }

  public async discoverFiles(): Promise<string[]> {
    return discoverCopilotCliSessionFiles({
      sessionsDir: this.sessionsDir,
      requireSessionsDir: this.requireSessionsDir,
    });
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);
    return events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const [content, workspaceMetadata] = await Promise.all([
      readFile(filePath, 'utf8'),
      loadCopilotCliWorkspaceMetadata(filePath),
    ]);

    return parseCopilotCliEvents(filePath, content, workspaceMetadata);
  }
}

export { getDefaultCopilotCliSessionsDir };
