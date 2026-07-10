import os from 'node:os';
import path from 'node:path';

import { normalizeNonNegativeInteger } from '../../domain/normalization.js';
import { inferCanonicalProviderRootFromModel } from '../../domain/provider-normalization.js';
import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import { discoverFilesAcrossRoots, resolveRootDirs } from '../multi-root-discovery.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import { asTrimmedText, normalizeTimestampCandidate, toNumberLike } from '../parsing-utils.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../source-adapter.js';

const defaultClaudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
const defaultClaudeRootDirs = [
  defaultClaudeProjectsDir,
  path.join(os.homedir(), '.claude', 'transcripts'),
];
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

export type ClaudeSourceAdapterOptions = {
  projectsDir?: string;
  requireProjectsDir?: boolean;
  /** Test seam: default roots scanned when no projectsDir override is given. */
  defaultRootDirs?: string[];
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
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  if (totalTokens === 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
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
  const messageId = asTrimmedText(message.id);

  if (messageId) {
    // Retries reuse the message id under a fresh requestId, so key on both:
    // streamed duplicates (same messageId + requestId) still collapse while
    // retried requests count separately.
    const requestId = asTrimmedText(line.requestId) ?? asTrimmedText(line.request_id) ?? '';
    return `${filePath}\0${messageId}\0${requestId}`;
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

  private readonly rootDirs: readonly string[];
  private readonly requireProjectsDir: boolean;

  public constructor(options: ClaudeSourceAdapterOptions = {}) {
    this.rootDirs = resolveRootDirs(
      options.projectsDir,
      options.defaultRootDirs ?? defaultClaudeRootDirs,
    );
    this.requireProjectsDir = options.requireProjectsDir ?? false;
  }

  public async discoverFiles(): Promise<string[]> {
    return discoverFilesAcrossRoots({
      rootDirs: this.rootDirs,
      requireDir: this.requireProjectsDir,
      directoryLabel: 'Claude projects directory',
      discoverInRoot: (rootDir) => discoverJsonlFiles(rootDir),
    });
  }

  public async parseFile(filePath: string): Promise<UsageEvent[]> {
    const { events } = await this.parseFileWithDiagnostics(filePath);
    return events;
  }

  public async parseFileWithDiagnostics(filePath: string): Promise<SourceParseFileDiagnostics> {
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

export function getDefaultClaudeProjectsDir(): string {
  return defaultClaudeProjectsDir;
}
