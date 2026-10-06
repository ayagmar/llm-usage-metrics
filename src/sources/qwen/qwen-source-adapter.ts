import os from 'node:os';
import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathIsDirectory, pathReadable } from '../../utils/fs-helpers.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import {
  asTrimmedText,
  isBlankText,
  normalizeTimestampCandidate,
  resolveTotalTokens,
  splitPromptIncludingCachedTokens,
  toTokenCount,
} from '../parsing-utils.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceParseFileDiagnostics,
} from '../source-adapter.js';

const defaultProjectsDir = path.join(os.homedir(), '.qwen', 'projects');
const QWEN_USAGE_LINE_TEXT = '"usageMetadata"';

export type QwenSourceAdapterOptions = SourceAdapterPathOptions;

type QwenTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens?: number;
};

function shouldParseQwenJsonlLine(lineText: string): boolean {
  return lineText.includes(QWEN_USAGE_LINE_TEXT);
}

function extractTokenUsage(
  usageMetadata: Record<string, unknown> | undefined,
): QwenTokenUsage | null {
  if (!usageMetadata) {
    return null;
  }

  const promptTokens = toTokenCount(usageMetadata.promptTokenCount);
  const candidatesTokens = toTokenCount(usageMetadata.candidatesTokenCount);
  const reasoningTokens = toTokenCount(usageMetadata.thoughtsTokenCount);
  const cachedTokens = toTokenCount(usageMetadata.cachedContentTokenCount);
  const cacheWriteTokens = 0;
  const declaredTotalTokens = toTokenCount(usageMetadata.totalTokenCount);

  // Qwen Code stores Gemini-shaped usageMetadata for every provider: promptTokenCount
  // always includes cached input. OpenAI/Anthropic-backed models report reasoning inside
  // candidatesTokenCount (total = prompt + candidates), while Gemini-native responses
  // report thoughts outside it (total = prompt + candidates + thoughts). Thoughts are
  // billed as output, so only the latter adds them to output.
  const { inputTokens, cacheReadTokens } = splitPromptIncludingCachedTokens(
    promptTokens,
    cachedTokens,
  );
  const thoughtsOutsideCandidates =
    reasoningTokens > 0 && declaredTotalTokens >= promptTokens + candidatesTokens + reasoningTokens;
  const outputTokens = candidatesTokens + (thoughtsOutsideCandidates ? reasoningTokens : 0);

  const componentTotalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  if (resolveTotalTokens(declaredTotalTokens, componentTotalTokens) === 0) {
    return null;
  }

  const extractedUsage = {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };

  if (declaredTotalTokens > 0) {
    return {
      ...extractedUsage,
      totalTokens: declaredTotalTokens,
    };
  }

  return extractedUsage;
}

function getFallbackSessionId(filePath: string): string {
  const chatsDir = path.dirname(filePath);
  const projectDir = path.dirname(chatsDir);
  const projectName = path.basename(projectDir);
  const fileStem = path.basename(filePath, '.jsonl');

  return `${projectName}-${fileStem}`;
}

export class QwenSourceAdapter implements SourceAdapter {
  public readonly id = 'qwen' as const;
  public readonly parserVersion = 2;

  private readonly projectsDir: string;
  private readonly requireDir: boolean;

  public constructor(options: QwenSourceAdapterOptions = {}) {
    this.projectsDir = options.dir ?? defaultProjectsDir;
    this.requireDir = options.requireDir ?? false;
  }

  private getNormalizedProjectsDir(): string {
    if (isBlankText(this.projectsDir)) {
      throw new Error('Qwen projects directory must be a non-empty path');
    }

    return this.projectsDir.trim();
  }

  public async discoverFiles(): Promise<string[]> {
    const normalizedDir = this.getNormalizedProjectsDir();

    if (this.requireDir && !(await pathReadable(normalizedDir))) {
      throw new Error(`Qwen projects directory is missing or unreadable: ${normalizedDir}`);
    }

    if (this.requireDir && !(await pathIsDirectory(normalizedDir))) {
      throw new Error(`Qwen projects directory is not a directory: ${normalizedDir}`);
    }

    return discoverJsonlFiles(normalizedDir);
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);
    return events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const events: UsageEvent[] = [];
    let skippedRows = 0;
    const skippedRowReasons = new Map<string, number>();
    const fallbackSessionId = getFallbackSessionId(filePath);

    for await (const line of readJsonlObjects(filePath, {
      shouldParseLine: shouldParseQwenJsonlLine,
      onMalformedLine: () => {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'json_parse_error');
      },
    })) {
      if (line.type !== 'assistant') {
        continue;
      }

      const usage = extractTokenUsage(asRecord(line.usageMetadata));

      if (!usage) {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'no_token_usage');
        continue;
      }

      const timestamp = normalizeTimestampCandidate(line.timestamp);

      if (!timestamp) {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'invalid_timestamp');
        continue;
      }

      try {
        events.push(
          createUsageEvent({
            source: this.id,
            sessionId: asTrimmedText(line.sessionId) ?? fallbackSessionId,
            timestamp,
            model: asTrimmedText(line.model),
            costMode: 'estimated',
            ...usage,
          }),
        );
      } catch {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'event_creation_failed');
        continue;
      }
    }

    return toParseDiagnostics(events, skippedRows, skippedRowReasons);
  }
}

export function getDefaultQwenProjectsDir(): string {
  return defaultProjectsDir;
}
