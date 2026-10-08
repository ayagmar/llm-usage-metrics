import os from 'node:os';
import path from 'node:path';

import { normalizeNonNegativeInteger } from '../../domain/normalization.js';
import { inferCanonicalProviderRootFromModel } from '../../domain/provider-normalization.js';
import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathStat } from '../../utils/fs-helpers.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import {
  discoverFilesAcrossRoots,
  isPathWithinRoots,
  resolveRootDirs,
} from '../multi-root-discovery.js';
import {
  getClaudeMessageKey,
  getClaudeSubagentMetaPath,
  readClaudeMessageKeys,
  resolveClaudeForkParentPath,
} from './claude-fork-transcript.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import { asTrimmedText, normalizeTimestampCandidate, toNumberLike } from '../parsing-utils.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceParseFileDiagnostics,
} from '../source-adapter.js';

function getClaudeRootDirsForConfigDir(configDir: string): string[] {
  return [path.join(configDir, 'projects'), path.join(configDir, 'transcripts')];
}

/**
 * Claude Code reads CLAUDE_CONFIG_DIR instead of ~/.claude. Like other usage tools, a
 * comma-separated value lists several config directories.
 */
export function resolveDefaultClaudeRootDirs(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string[] {
  const configDirs = (env.CLAUDE_CONFIG_DIR ?? '')
    .split(',')
    .map((configDir) => configDir.trim())
    .filter((configDir) => configDir.length > 0);

  if (configDirs.length === 0) {
    return getClaudeRootDirsForConfigDir(path.join(homeDir, '.claude'));
  }

  return configDirs.flatMap((configDir) => getClaudeRootDirsForConfigDir(configDir));
}
const CLAUDE_ASSISTANT_BYTES = Buffer.from('"assistant"');
const CLAUDE_USAGE_BYTES = Buffer.from('"usage"');

type ClaudeUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

type ClaudePendingEvent = {
  sessionId: string;
  timestamp: string;
  repoRoot?: string;
  provider?: string;
  model?: string;
  usage: ClaudeUsage;
  sequence: number;
};

export type ClaudeSourceAdapterOptions = Omit<SourceAdapterPathOptions, 'dir'> & {
  /** One projects directory, or several that share fork deduplication. */
  dir?: string | readonly string[];
  /** Test seam: default roots scanned when no dir override is given. */
  defaultRootDirs?: string[];
  env?: NodeJS.ProcessEnv;
};

function shouldParseClaudeJsonlLineBytes(lineBytes: Buffer): boolean {
  return lineBytes.includes(CLAUDE_ASSISTANT_BYTES) && lineBytes.includes(CLAUDE_USAGE_BYTES);
}

function getFallbackSessionId(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

function resolveProvider(
  message: Record<string, unknown>,
  model: string | undefined,
): string | undefined {
  const explicitProvider = asTrimmedText(message.provider);

  if (explicitProvider) {
    return explicitProvider;
  }

  return model ? inferCanonicalProviderRootFromModel(model) : undefined;
}

function parseUsage(usage: Record<string, unknown>): ClaudeUsage | undefined {
  const inputTokens = normalizeNonNegativeInteger(toNumberLike(usage.input_tokens));
  const outputTokens = normalizeNonNegativeInteger(toNumberLike(usage.output_tokens));
  const cacheReadTokens = normalizeNonNegativeInteger(toNumberLike(usage.cache_read_input_tokens));
  const cacheWriteTokens = normalizeNonNegativeInteger(
    toNumberLike(usage.cache_creation_input_tokens),
  );
  // output_tokens already includes thinking; the details field is only a breakdown.
  const thinkingTokens = normalizeNonNegativeInteger(
    toNumberLike(asRecord(usage.output_tokens_details)?.thinking_tokens),
  );
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  if (totalTokens === 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, thinkingTokens),
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

function createDedupKey(
  filePath: string,
  line: Record<string, unknown>,
  message: Record<string, unknown>,
  timestamp: string,
  model: string | undefined,
): string {
  // Streamed duplicates (same messageId + requestId) collapse while retried
  // requests, which reuse the message id under a fresh requestId, count separately.
  const messageKey = getClaudeMessageKey(line, message);

  if (messageKey) {
    return `${filePath}\0${messageKey}`;
  }

  const uuid = asTrimmedText(line.uuid);

  if (uuid) {
    return `${filePath}\0${uuid}`;
  }

  // Some Claude transcripts omit both message.id and uuid (e.g. synthetic or
  // stripped logs). A real usage row always has a timestamp at this point (we
  // skip invalid timestamps earlier), so fall back to a content-based key so
  // genuine usage is never dropped merely for lacking identifiers.
  return `${filePath}\0${timestamp}\0${model ?? ''}`;
}

function comparePendingEvents(left: ClaudePendingEvent, right: ClaudePendingEvent): number {
  if (left.timestamp !== right.timestamp) {
    return compareByCodePoint(left.timestamp, right.timestamp);
  }

  return left.sequence - right.sequence;
}

export class ClaudeSourceAdapter implements SourceAdapter {
  public readonly id = 'claude' as const;
  public readonly parserVersion = 3;
  public readonly capabilities = { eventsPrecedeFileMtime: true } as const;

  private readonly rootDirs: readonly string[];
  private readonly requireDir: boolean;
  // Sibling forks share a parent; read its message keys once per parent version.
  private readonly parentMessageKeysByVersion = new Map<string, Promise<Set<string>>>();

  public constructor(options: ClaudeSourceAdapterOptions = {}) {
    this.rootDirs = resolveRootDirs(
      options.dir,
      options.defaultRootDirs ?? resolveDefaultClaudeRootDirs(options.env),
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
      directoryLabel: 'Claude projects directory',
      discoverInRoot: (rootDir) => discoverJsonlFiles(rootDir),
    });
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);
    return events;
  }

  public async getParseDependencies(filePath: string): Promise<string[]> {
    const metaPath = getClaudeSubagentMetaPath(filePath);

    if (!metaPath) {
      return [];
    }

    // Only a parent this adapter can discover changes the parse result, so the dependency
    // also keys the cache on whether replayed rows were skipped.
    const forkParentPath = await resolveClaudeForkParentPath(filePath);
    return forkParentPath && isPathWithinRoots(forkParentPath, this.rootDirs)
      ? [metaPath, forkParentPath]
      : [metaPath];
  }

  private async readParentMessageKeys(parentPath: string): Promise<Set<string>> {
    const parentStats = await pathStat(parentPath);

    if (!parentStats) {
      return new Set();
    }

    const versionKey = `${parentPath}\0${parentStats.size}\0${parentStats.mtimeMs}`;
    let messageKeys = this.parentMessageKeysByVersion.get(versionKey);

    if (!messageKeys) {
      messageKeys = readClaudeMessageKeys(parentPath);
      this.parentMessageKeysByVersion.set(versionKey, messageKeys);
    }

    return messageKeys;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
    const forkParentPath = await resolveClaudeForkParentPath(filePath);
    // Rows a forked subagent replayed from its parent are counted in the parent transcript,
    // provided this adapter's discovery covers the parent.
    const parentMessageKeys =
      forkParentPath && isPathWithinRoots(forkParentPath, this.rootDirs)
        ? await this.readParentMessageKeys(forkParentPath)
        : new Set<string>();
    const eventsByDedupKey = new Map<string, ClaudePendingEvent>();
    let skippedRows = 0;
    let sequence = 0;
    const skippedRowReasons = new Map<string, number>();

    for await (const line of readJsonlObjects(filePath, {
      shouldParseLineBytes: shouldParseClaudeJsonlLineBytes,
      onMalformedLine: () => {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'json_parse_error');
      },
    })) {
      if (asTrimmedText(line.type) !== 'assistant') {
        continue;
      }

      const message = asRecord(line.message);

      if (!message || asTrimmedText(message.role) !== 'assistant') {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'invalid_assistant_message');
        continue;
      }

      const model = asTrimmedText(message.model);

      if (model === '<synthetic>') {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'synthetic_message');
        continue;
      }

      const messageKey = getClaudeMessageKey(line, message);

      if (messageKey && parentMessageKeys.has(messageKey)) {
        continue;
      }

      const usage = parseUsage(asRecord(message.usage) ?? {});

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

      const dedupKey = createDedupKey(filePath, line, message, timestamp, model);

      const sessionId = asTrimmedText(line.sessionId) ?? getFallbackSessionId(filePath);
      const repoRoot = asTrimmedText(line.cwd);
      const provider = resolveProvider(message, model);

      sequence += 1;
      eventsByDedupKey.set(dedupKey, {
        sessionId,
        timestamp,
        repoRoot,
        provider,
        model,
        usage,
        sequence,
      });
    }

    const events: UsageEvent[] = [];

    for (const pendingEvent of [...eventsByDedupKey.values()].sort(comparePendingEvents)) {
      try {
        events.push(
          createUsageEvent({
            source: this.id,
            sessionId: pendingEvent.sessionId,
            timestamp: pendingEvent.timestamp,
            repoRoot: pendingEvent.repoRoot,
            provider: pendingEvent.provider,
            model: pendingEvent.model,
            ...pendingEvent.usage,
            costMode: 'estimated',
          }),
        );
      } catch {
        skippedRows++;
        incrementSkippedReason(skippedRowReasons, 'event_creation_failed');
      }
    }

    return toParseDiagnostics(events, skippedRows, skippedRowReasons);
  }
}

/** The projects directory under ~/.claude, ignoring CLAUDE_CONFIG_DIR. */
export function getDefaultClaudeProjectsDir(): string {
  return resolveDefaultClaudeRootDirs({})[0];
}
