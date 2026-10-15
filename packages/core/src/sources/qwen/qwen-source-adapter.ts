import path from 'node:path';

import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathIsDirectory, pathReadable } from '../../utils/fs-helpers.js';
import { readJsonlFromCursor } from '../../stream/cursor.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import { createReadDiagnostics, recordSkippedRow } from '../parse-diagnostics.js';
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
  SourceReadOptions,
} from '../source-adapter.js';
import { createSourceContext, type SourceContext } from '../source-context.js';

function resolveDefaultQwenProjectsDir(context: SourceContext): string {
  return path.join(context.homeDir, '.qwen', 'projects');
}

const QWEN_USAGE_LINE_TEXT = '"usageMetadata"';

/** Options for `QwenSourceAdapter`. */
export type QwenSourceAdapterOptions = SourceAdapterPathOptions;

type QwenTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

function shouldParseQwenJsonlLine(lineText: string): boolean {
  return lineText.includes(QWEN_USAGE_LINE_TEXT);
}

function reportsThoughtsOutsideCandidates(
  usage: { promptTokens: number; candidatesTokens: number; reasoningTokens: number },
  declaredTotalTokens: number,
  model: string | undefined,
): boolean {
  if (usage.reasoningTokens === 0) {
    return false;
  }

  if (declaredTotalTokens > 0) {
    return (
      declaredTotalTokens >= usage.promptTokens + usage.candidatesTokens + usage.reasoningTokens
    );
  }

  // Without a declared total, only the model family tells the layouts apart.
  return model?.toLowerCase().startsWith('gemini') ?? false;
}

function extractTokenUsage(
  usageMetadata: Record<string, unknown> | undefined,
  model: string | undefined,
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
  const thoughtsOutsideCandidates = reportsThoughtsOutsideCandidates(
    { promptTokens, candidatesTokens, reasoningTokens },
    declaredTotalTokens,
    model,
  );
  const outputTokens = candidatesTokens + (thoughtsOutsideCandidates ? reasoningTokens : 0);

  const componentTotalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  if (resolveTotalTokens(declaredTotalTokens, componentTotalTokens) === 0) {
    return null;
  }

  // Reasoning is a breakdown of output, so the fallback total must not add it again.
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: resolveTotalTokens(declaredTotalTokens, componentTotalTokens),
  };
}

function getFallbackSessionId(filePath: string): string {
  const chatsDir = path.dirname(filePath);
  const projectDir = path.dirname(chatsDir);
  const projectName = path.basename(projectDir);
  const fileStem = path.basename(filePath, '.jsonl');

  return `${projectName}-${fileStem}`;
}

/** Qwen Code chats (JSONL), from `~/.qwen/projects`. Incremental: honours `resume`. */
export class QwenSourceAdapter implements SourceAdapter {
  public readonly id = 'qwen' as const;
  public readonly parserVersion = 4;
  public readonly capabilities = {
    eventsPrecedeFileMtime: true,
    incremental: true,
    kinds: ['usage'],
  } as const;

  private readonly projectsDir: string;
  private readonly requireDir: boolean;

  public constructor(options: QwenSourceAdapterOptions = {}) {
    this.projectsDir =
      options.dir ?? resolveDefaultQwenProjectsDir(options.context ?? createSourceContext());
    this.requireDir = options.requireDir ?? false;
  }

  private getNormalizedProjectsDir(): string {
    if (isBlankText(this.projectsDir)) {
      throw new Error('Qwen projects directory must be a non-empty path');
    }

    return this.projectsDir.trim();
  }

  public getSearchPaths(): string[] {
    return [this.projectsDir].map((searchPath) => searchPath.trim());
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

  public async *read(
    filePath: string,
    options: SourceReadOptions = {},
  ): AsyncGenerator<UsageEvent> {
    const diagnostics = options.diagnostics ?? createReadDiagnostics();
    const fallbackSessionId = getFallbackSessionId(filePath);
    const lineOptions = {
      shouldParseLine: shouldParseQwenJsonlLine,
      onMalformedLine: () => {
        recordSkippedRow(diagnostics, 'json_parse_error');
      },
    };
    // Each line parses on its own, so a resumed read only needs the lines after the cursor.
    const lines = options.resume
      ? readJsonlFromCursor(this, filePath, options.resume, (position) =>
          readJsonlObjects(filePath, { ...lineOptions, position }),
        )
      : readJsonlObjects(filePath, lineOptions);

    for await (const line of lines) {
      if (line.type !== 'assistant') {
        continue;
      }

      const usage = extractTokenUsage(asRecord(line.usageMetadata), asTrimmedText(line.model));

      if (!usage) {
        recordSkippedRow(diagnostics, 'no_token_usage');
        continue;
      }

      const timestamp = normalizeTimestampCandidate(line.timestamp);

      if (!timestamp) {
        recordSkippedRow(diagnostics, 'invalid_timestamp');
        continue;
      }

      let event: UsageEvent;

      try {
        event = createUsageEvent({
          source: this.id,
          sessionId: asTrimmedText(line.sessionId) ?? fallbackSessionId,
          timestamp,
          model: asTrimmedText(line.model),
          ...usage,
        });
      } catch {
        recordSkippedRow(diagnostics, 'event_creation_failed');
        continue;
      }

      yield event;
    }
  }
}
