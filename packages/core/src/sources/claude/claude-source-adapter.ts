import path from 'node:path';

import { normalizeNonNegativeInteger } from '../../domain/normalization.js';
import { inferCanonicalProviderRootFromModel } from '../../domain/provider-normalization.js';
import {
  createUsageRecord,
  EVENT_KINDS,
  type EventKind,
  type SessionEvent,
  type UsageRecord,
} from '../../domain/session-event.js';
import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathStat } from '../../utils/fs-helpers.js';
import {
  readClassifiedJsonlObjectBatches,
  readJsonlObjectBatches,
} from '../../utils/read-jsonl-objects.js';
import {
  discoverFilesAcrossRoots,
  isPathWithinRoots,
  resolveRootDirs,
} from '../multi-root-discovery.js';
import {
  getClaudeMessageKey,
  getClaudeSubagentMetaPath,
  readClaudeMessageKeys,
  readClaudeRowUuids,
  resolveClaudeForkParentPath,
} from './claude-fork-transcript.js';
import {
  ClaudeSessionEvents,
  leanClaudeSessionLineBytes,
  shouldParseClaudeSessionLineBytes,
} from './claude-session-events.js';
import { createReadDiagnostics, recordSkippedRow } from '../parse-diagnostics.js';
import { asTrimmedText, normalizeTimestampCandidate, toNumberLike } from '../parsing-utils.js';
import { recordMalformedLine, resolveReadKinds } from '../session-event-helpers.js';
import type {
  ReadEventsOptions,
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceReadDiagnostics,
  SourceReadOptions,
} from '../source-adapter.js';
import { createSourceContext, type SourceContext } from '../source-context.js';

function getClaudeRootDirsForConfigDir(configDir: string): string[] {
  return [path.join(configDir, 'projects'), path.join(configDir, 'transcripts')];
}

/**
 * Claude Code reads CLAUDE_CONFIG_DIR instead of ~/.claude. Like other usage tools, a
 * comma-separated value lists several config directories.
 */
export function resolveDefaultClaudeRootDirs(context: SourceContext): string[] {
  const configDirs = (context.env.CLAUDE_CONFIG_DIR ?? '')
    .split(',')
    .map((configDir) => configDir.trim())
    .filter((configDir) => configDir.length > 0);

  if (configDirs.length === 0) {
    return getClaudeRootDirsForConfigDir(path.join(context.homeDir, '.claude'));
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
  cacheWrite1hTokens: number;
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
  // Set only when the read yields usage records.
  messageId?: string;
  requestId?: string;
  rawProvider?: string;
  raw?: Record<string, unknown>;
};

/** One read of a file: `read` is usage-only, without the record fields. */
type ClaudeReadPlan = {
  kinds: ReadonlySet<EventKind>;
  text: boolean;
  raw: boolean;
  diagnostics: SourceReadDiagnostics;
};

const USAGE_ONLY: ReadonlySet<EventKind> = new Set(['usage']);

/** Options for `ClaudeSourceAdapter`. */
export type ClaudeSourceAdapterOptions = Omit<SourceAdapterPathOptions, 'dir'> & {
  /** One projects directory, or several that share fork deduplication. */
  dir?: string | readonly string[];
  /** Test seam: default roots scanned when no dir override is given. @internal */
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
  // cache_creation splits the writes by lifetime; one-hour writes bill at a higher rate.
  const cacheWrite1hTokens = normalizeNonNegativeInteger(
    toNumberLike(asRecord(usage.cache_creation)?.ephemeral_1h_input_tokens),
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
    cacheWrite1hTokens: Math.min(cacheWriteTokens, cacheWrite1hTokens),
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

/** A parent transcript's ids at one version of the file. */
type ParentVersionIds = { versionKey: string; ids: Promise<Set<string>> };

/**
 * A parent transcript's ids, read once per parent version. Only the latest version per
 * parent path is kept, so a parent that grows does not leave one set per version behind.
 */
async function readParentVersion(
  parentPath: string,
  cache: Map<string, ParentVersionIds>,
  read: (parentPath: string) => Promise<Set<string>>,
): Promise<Set<string>> {
  const parentStats = await pathStat(parentPath);

  if (!parentStats) {
    return new Set();
  }

  const versionKey = `${parentStats.size}\0${parentStats.mtimeMs}`;
  const cached = cache.get(parentPath);

  if (cached?.versionKey === versionKey) {
    return cached.ids;
  }

  const ids = read(parentPath);
  cache.set(parentPath, { versionKey, ids });
  return ids;
}

/** The usage of a file's assistant rows: last row per dedup key, sorted at the end. */
class ClaudeUsageRows {
  private readonly eventsByDedupKey = new Map<string, ClaudePendingEvent>();
  private sequence = 0;

  public constructor(
    private readonly filePath: string,
    private readonly parentMessageKeys: ReadonlySet<string>,
    private readonly plan: ClaudeReadPlan & { records: boolean },
  ) {}

  public add(line: Record<string, unknown>): void {
    const { diagnostics } = this.plan;

    if (asTrimmedText(line.type) !== 'assistant') {
      return;
    }

    const message = asRecord(line.message);

    if (!message || asTrimmedText(message.role) !== 'assistant') {
      recordSkippedRow(diagnostics, 'invalid_assistant_message');
      return;
    }

    const model = asTrimmedText(message.model);

    if (model === '<synthetic>') {
      recordSkippedRow(diagnostics, 'synthetic_message');
      return;
    }

    const messageKey = getClaudeMessageKey(line, message);

    if (messageKey && this.parentMessageKeys.has(messageKey)) {
      return;
    }

    const usage = parseUsage(asRecord(message.usage) ?? {});

    if (!usage) {
      recordSkippedRow(diagnostics, 'no_token_usage');
      return;
    }

    const timestamp = normalizeTimestampCandidate(line.timestamp);

    if (!timestamp) {
      recordSkippedRow(diagnostics, 'invalid_timestamp');
      return;
    }

    const dedupKey = createDedupKey(this.filePath, line, message, timestamp, model);

    const sessionId = asTrimmedText(line.sessionId) ?? getFallbackSessionId(this.filePath);
    const repoRoot = asTrimmedText(line.cwd);
    const provider = resolveProvider(message, model);

    this.sequence += 1;
    const pendingEvent: ClaudePendingEvent = {
      sessionId,
      timestamp,
      repoRoot,
      provider,
      model,
      usage,
      sequence: this.sequence,
    };

    if (this.plan.records) {
      pendingEvent.messageId = asTrimmedText(message.id);
      pendingEvent.requestId = asTrimmedText(line.requestId) ?? asTrimmedText(line.request_id);
      pendingEvent.rawProvider = asTrimmedText(message.provider);
      pendingEvent.raw = this.plan.raw ? line : undefined;
    }

    this.eventsByDedupKey.set(dedupKey, pendingEvent);
  }

  public *flush(): Generator<UsageEvent | UsageRecord> {
    // Keep-last by dedup key and the timestamp sort need the whole file before any event.
    for (const pendingEvent of [...this.eventsByDedupKey.values()].sort(comparePendingEvents)) {
      const input = {
        source: 'claude',
        sessionId: pendingEvent.sessionId,
        timestamp: pendingEvent.timestamp,
        repoRoot: pendingEvent.repoRoot,
        provider: pendingEvent.provider,
        model: pendingEvent.model,
        ...pendingEvent.usage,
        singleRequest: true,
      };
      let event: UsageEvent | UsageRecord;

      try {
        event = this.plan.records
          ? createUsageRecord({
              ...input,
              messageId: pendingEvent.messageId,
              requestId: pendingEvent.requestId,
              rawProvider: pendingEvent.rawProvider,
              raw: pendingEvent.raw,
            })
          : createUsageEvent(input);
      } catch {
        recordSkippedRow(this.plan.diagnostics, 'event_creation_failed');
        continue;
      }

      yield event;
    }
  }
}

/**
 * Claude Code transcripts (JSONL), from `projects` and `transcripts` under each directory in
 * `$CLAUDE_CONFIG_DIR` (comma-separated; default `~/.claude`). Yields every event kind. A
 * forked session's events depend on its parent transcript, found under the same roots.
 */
export class ClaudeSourceAdapter implements SourceAdapter {
  public readonly id = 'claude' as const;
  public readonly parserVersion = 4;
  public readonly capabilities = {
    eventsPrecedeFileMtime: true,
    sessionsCopyEvents: true,
    kinds: EVENT_KINDS,
  } as const;

  private readonly rootDirs: readonly string[];
  private readonly requireDir: boolean;
  // Sibling forks share a parent; read its message keys once per parent version.
  private readonly parentMessageKeysByPath = new Map<string, ParentVersionIds>();
  // Read only for non-usage kinds, so `read` never reads them.
  private readonly parentRowUuidsByPath = new Map<string, ParentVersionIds>();

  public constructor(options: ClaudeSourceAdapterOptions = {}) {
    this.rootDirs = resolveRootDirs(
      options.dir,
      options.defaultRootDirs ??
        resolveDefaultClaudeRootDirs(options.context ?? createSourceContext()),
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
    return readParentVersion(parentPath, this.parentMessageKeysByPath, readClaudeMessageKeys);
  }

  private async readParentRowUuids(parentPath: string): Promise<Set<string>> {
    return readParentVersion(parentPath, this.parentRowUuidsByPath, readClaudeRowUuids);
  }

  public read(filePath: string, options: SourceReadOptions = {}): AsyncGenerator<UsageEvent> {
    return this.parse(filePath, {
      kinds: USAGE_ONLY,
      text: false,
      raw: false,
      diagnostics: options.diagnostics ?? createReadDiagnostics(),
      records: false,
    });
  }

  public readEvents(
    filePath: string,
    options: ReadEventsOptions = {},
  ): AsyncGenerator<SessionEvent> {
    return this.parse(filePath, {
      kinds: resolveReadKinds(options.kinds, this.capabilities.kinds),
      text: options.text ?? false,
      raw: options.raw ?? false,
      diagnostics: options.diagnostics ?? createReadDiagnostics(),
      records: true,
    });
  }

  private parse(
    filePath: string,
    plan: ClaudeReadPlan & { records: false },
  ): AsyncGenerator<UsageEvent>;
  private parse(
    filePath: string,
    plan: ClaudeReadPlan & { records: true },
  ): AsyncGenerator<SessionEvent>;
  private async *parse(
    filePath: string,
    plan: ClaudeReadPlan & { records: boolean },
  ): AsyncGenerator<UsageEvent | SessionEvent> {
    const { kinds, diagnostics } = plan;
    const readsUsage = kinds.has('usage');
    const readsSessionEvents = kinds.size > (readsUsage ? 1 : 0);

    if (!readsUsage && !readsSessionEvents) {
      return;
    }

    const forkParentPath = await resolveClaudeForkParentPath(filePath);
    // Rows a forked subagent replayed from its parent are counted in the parent transcript,
    // provided this adapter's discovery covers the parent.
    const countedForkParentPath =
      forkParentPath && isPathWithinRoots(forkParentPath, this.rootDirs)
        ? forkParentPath
        : undefined;
    const parentMessageKeys = countedForkParentPath
      ? await this.readParentMessageKeys(countedForkParentPath)
      : new Set<string>();
    const usageRows = new ClaudeUsageRows(filePath, parentMessageKeys, plan);

    if (!readsSessionEvents) {
      for await (const lines of readJsonlObjectBatches(filePath, {
        shouldParseLineBytes: shouldParseClaudeJsonlLineBytes,
        onMalformedLine: () => {
          recordSkippedRow(diagnostics, 'json_parse_error');
        },
      })) {
        for (const line of lines) {
          usageRows.add(line);
        }
      }

      for (const event of usageRows.flush()) {
        yield event;
      }

      return;
    }

    const sessionEvents = new ClaudeSessionEvents({
      fallbackSessionId: getFallbackSessionId(filePath),
      kinds,
      text: plan.text,
      raw: plan.raw,
      diagnostics,
      replayedRowUuids: countedForkParentPath
        ? await this.readParentRowUuids(countedForkParentPath)
        : new Set<string>(),
      replayedMessageKeys: parentMessageKeys,
    });

    for await (const items of readClassifiedJsonlObjectBatches(filePath, {
      shouldParseLineBytes: shouldParseClaudeSessionLineBytes,
      isUsageLineBytes: shouldParseClaudeJsonlLineBytes,
      leanLineBytes: plan.raw ? undefined : leanClaudeSessionLineBytes,
      onMalformedLine: (lineBytes) => {
        recordMalformedLine(diagnostics, kinds, shouldParseClaudeJsonlLineBytes(lineBytes));
      },
    })) {
      for (const { record, isUsageLine } of items) {
        if (readsUsage && isUsageLine) {
          usageRows.add(record);
        }

        for (const event of sessionEvents.add(record)) {
          yield event;
        }
      }
    }

    // Unanswered tool calls come before the usage, which is sorted at the end of the file.
    for (const event of sessionEvents.finish()) {
      yield event;
    }

    if (readsUsage) {
      for (const event of usageRows.flush()) {
        yield event;
      }
    }
  }
}
