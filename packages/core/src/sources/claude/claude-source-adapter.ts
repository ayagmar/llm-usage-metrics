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
import {
  readJsonlFromStatefulCursor,
  ResumeConflict,
  type ReadResume,
  type ReplacedEventCounts,
  type ResumablePass,
} from '../../stream/cursor.js';
import { decodeIdHashes, encodeIdHashes, ResumableIdSet } from '../../stream/cursor-state.js';
import { asRecord } from '../../utils/as-record.js';
import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import {
  readClassifiedJsonlObjectBatches,
  readJsonlObjectBatches,
} from '../../utils/read-jsonl-objects.js';
import {
  discoverFilesAcrossRoots,
  isPathWithinRoots,
  resolveRootDirs,
} from '../multi-root-discovery.js';
import { readParentVersion, type ParentVersion } from '../parent-version-cache.js';
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
import {
  finishResumableSessionEvents,
  recordMalformedLine,
  resolveReadKinds,
} from '../session-event-helpers.js';
import type {
  ReadEventsOptions,
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceReadDiagnostics,
  SourceReadOptions,
} from '../source-adapter.js';
import { createSourceContext, type SourceContext } from '../source-context.js';
import {
  getClaudeReadPlanKey,
  parseClaudeCursorState,
  type ClaudeCursorState,
  type ClaudePendingEvent,
  type ClaudeUsage,
  type ClaudeUsageState,
} from './claude-cursor-state.js';

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

function compareSortKeys(
  left: Pick<ClaudePendingEvent, 'timestamp' | 'sequence'>,
  right: Pick<ClaudePendingEvent, 'timestamp' | 'sequence'>,
): number {
  if (left.timestamp !== right.timestamp) {
    return compareByCodePoint(left.timestamp, right.timestamp);
  }

  return left.sequence - right.sequence;
}

/** The usage of a file's assistant rows: last row per dedup key, sorted at the end. */
class ClaudeUsageRows {
  private readonly eventsByDedupKey = new Map<string, ClaudePendingEvent>();
  private sequence = 0;
  private lastKey: string | undefined;
  // Under a cursor: the keys of the events yielded and settled before it, as hashes.
  private readonly settledKeyHashes: ReadonlySet<number>;
  private readonly settledKeys: ResumableIdSet;
  private readonly settledLast: [string, number] | undefined;
  private endState: ClaudeUsageState | undefined;
  private openCount = 0;

  public constructor(
    private readonly filePath: string,
    private readonly parentMessageKeys: ReadonlySet<string>,
    private readonly plan: ClaudeReadPlan & { records: boolean },
    from?: ClaudeUsageState,
  ) {
    this.settledKeyHashes = (from && decodeIdHashes(from.settledKeys)) ?? new Set();
    this.settledKeys = new ResumableIdSet(this.settledKeyHashes);
    this.settledLast = from?.settledLast;

    if (from) {
      this.sequence = from.sequence;
      this.lastKey = from.lastKey;

      for (const pendingEvent of from.open) {
        this.eventsByDedupKey.set(pendingEvent.key, pendingEvent);
      }
    }
  }

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

    // A settled event's key coming back would replace an event already yielded.
    if (!this.eventsByDedupKey.has(dedupKey) && this.settledKeys.has(dedupKey)) {
      throw new ResumeConflict();
    }

    const sessionId = asTrimmedText(line.sessionId) ?? getFallbackSessionId(this.filePath);
    const repoRoot = asTrimmedText(line.cwd);
    const provider = resolveProvider(message, model);

    this.sequence += 1;
    const pendingEvent: ClaudePendingEvent = {
      key: dedupKey,
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
    this.lastKey = dedupKey;
  }

  /**
   * Yields every event, sorted. Under a cursor, the events must all sort after the ones
   * settled before it, or the read restarts. `trackState` keeps the state to resume from.
   */
  public *flush(trackState: boolean): Generator<UsageEvent | UsageRecord> {
    // Keep-last by dedup key and the timestamp sort need the whole file before any event.
    const pendingEvents = [...this.eventsByDedupKey.values()].sort(compareSortKeys);
    const settledLast = this.settledLast;

    if (
      settledLast &&
      pendingEvents.length > 0 &&
      compareSortKeys(pendingEvents[0], { timestamp: settledLast[0], sequence: settledLast[1] }) <=
        0
    ) {
      throw new ResumeConflict();
    }

    const lastEvent =
      this.lastKey === undefined ? undefined : this.eventsByDedupKey.get(this.lastKey);
    const openFrom = lastEvent ? pendingEvents.indexOf(lastEvent) : pendingEvents.length;
    let resumable = true;

    for (const [index, pendingEvent] of pendingEvents.entries()) {
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
        // The next read would count an open event's failure again.
        resumable &&= index < openFrom;
        continue;
      }

      yield event;
    }

    if (!trackState || !resumable) {
      return;
    }

    const lastSettled = pendingEvents[openFrom - 1];
    this.openCount = pendingEvents.length - openFrom;
    this.endState = {
      sequence: this.sequence,
      lastKey: this.lastKey,
      settledKeys: encodeIdHashes(
        this.settledKeyHashes,
        pendingEvents.slice(0, openFrom).map((pendingEvent) => pendingEvent.key),
      ),
      open: pendingEvents.slice(openFrom),
      settledLast: openFrom > 0 ? [lastSettled.timestamp, lastSettled.sequence] : settledLast,
    };
  }

  /** After `flush(true)`: the state to resume from and how many events it leaves open. */
  public toState(): { state: ClaudeUsageState; openCount: number } | undefined {
    return this.endState && { state: this.endState, openCount: this.openCount };
  }
}

/**
 * Claude Code transcripts (JSONL), from `projects` and `transcripts` under each directory in
 * `$CLAUDE_CONFIG_DIR` (comma-separated; default `~/.claude`). Yields every event kind. A
 * forked session's events depend on its parent transcript, found under the same roots.
 * Incremental: honours `resume`, with its parse state in the cursor.
 */
export class ClaudeSourceAdapter implements SourceAdapter {
  public readonly id = 'claude' as const;
  public readonly parserVersion = 4;
  public readonly capabilities = {
    eventsPrecedeFileMtime: true,
    sessionsCopyEvents: true,
    kinds: EVENT_KINDS,
    incremental: true,
  } as const;

  private readonly rootDirs: readonly string[];
  private readonly requireDir: boolean;
  // Sibling forks share a parent; read its message keys once per parent version.
  private readonly parentMessageKeysByPath = new Map<string, ParentVersion<Set<string>>>();
  // Read only for non-usage kinds, so `read` never reads them.
  private readonly parentRowUuidsByPath = new Map<string, ParentVersion<Set<string>>>();

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
    return (
      (await readParentVersion(parentPath, this.parentMessageKeysByPath, readClaudeMessageKeys)) ??
      new Set()
    );
  }

  private async readParentRowUuids(parentPath: string): Promise<Set<string>> {
    return (
      (await readParentVersion(parentPath, this.parentRowUuidsByPath, readClaudeRowUuids)) ??
      new Set()
    );
  }

  public read(filePath: string, options: SourceReadOptions = {}): AsyncGenerator<UsageEvent> {
    const plan = {
      kinds: USAGE_ONLY,
      text: false,
      raw: false,
      diagnostics: options.diagnostics ?? createReadDiagnostics(),
      records: false,
    } as const;

    return options.resume
      ? this.readFromCursor(filePath, plan, options.resume)
      : this.parse(filePath, plan);
  }

  public readEvents(
    filePath: string,
    options: ReadEventsOptions = {},
  ): AsyncGenerator<SessionEvent> {
    const plan = {
      kinds: resolveReadKinds(options.kinds, this.capabilities.kinds),
      text: options.text ?? false,
      raw: options.raw ?? false,
      diagnostics: options.diagnostics ?? createReadDiagnostics(),
      records: true,
    } as const;

    return options.resume && plan.kinds.has('usage')
      ? this.readFromCursor(filePath, plan, options.resume)
      : this.parse(filePath, plan);
  }

  private readFromCursor(
    filePath: string,
    plan: ClaudeReadPlan & { records: false },
    resume: ReadResume,
  ): AsyncGenerator<UsageEvent>;
  private readFromCursor(
    filePath: string,
    plan: ClaudeReadPlan & { records: true },
    resume: ReadResume,
  ): AsyncGenerator<SessionEvent>;
  private readFromCursor(
    filePath: string,
    plan: ClaudeReadPlan & { records: boolean },
    resume: ReadResume,
  ): AsyncGenerator<UsageEvent | SessionEvent> {
    const planKey = getClaudeReadPlanKey(plan);

    return readJsonlFromStatefulCursor(this, filePath, resume, plan.diagnostics, {
      parseState: (value) => parseClaudeCursorState(value, planKey),
      parse: (pass, diagnostics) => this.parse(filePath, { ...plan, diagnostics }, pass),
    });
  }

  private parse(
    filePath: string,
    plan: ClaudeReadPlan & { records: false },
    resumable?: ResumablePass<ClaudeCursorState>,
  ): AsyncGenerator<UsageEvent>;
  private parse(
    filePath: string,
    plan: ClaudeReadPlan & { records: true },
    resumable?: ResumablePass<ClaudeCursorState>,
  ): AsyncGenerator<SessionEvent>;
  private parse(
    filePath: string,
    plan: ClaudeReadPlan & { records: boolean },
    resumable?: ResumablePass<ClaudeCursorState>,
  ): AsyncGenerator<UsageEvent | SessionEvent>;
  private async *parse(
    filePath: string,
    plan: ClaudeReadPlan & { records: boolean },
    resumable?: ResumablePass<ClaudeCursorState>,
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
    const from = resumable?.from;
    const usageRows = new ClaudeUsageRows(filePath, parentMessageKeys, plan, from?.usage);
    const position = resumable?.position;

    if (!readsSessionEvents) {
      for await (const lines of readJsonlObjectBatches(filePath, {
        shouldParseLineBytes: shouldParseClaudeJsonlLineBytes,
        onMalformedLine: () => {
          recordSkippedRow(diagnostics, 'json_parse_error');
        },
        position,
      })) {
        for (const line of lines) {
          usageRows.add(line);
        }
      }

      yield* usageRows.flush(resumable !== undefined);
      resumable?.end(toCursorState(plan, usageRows, undefined, {}));
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
      from: from && (from.session ?? null),
    });

    for await (const items of readClassifiedJsonlObjectBatches(filePath, {
      shouldParseLineBytes: shouldParseClaudeSessionLineBytes,
      isUsageLineBytes: shouldParseClaudeJsonlLineBytes,
      leanLineBytes: plan.raw ? undefined : leanClaudeSessionLineBytes,
      onMalformedLine: (lineBytes) => {
        recordMalformedLine(diagnostics, kinds, shouldParseClaudeJsonlLineBytes(lineBytes));
      },
      position,
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
    const end = yield* finishResumableSessionEvents(
      sessionEvents,
      diagnostics,
      resumable !== undefined,
    );

    if (readsUsage) {
      yield* usageRows.flush(resumable !== undefined);
    }

    resumable?.end(end && toCursorState(plan, usageRows, end.state, end.replaced));
  }
}

/** The state to resume from after a read under a cursor, or undefined when it cannot. */
function toCursorState(
  plan: ClaudeReadPlan & { records: boolean },
  usageRows: ClaudeUsageRows,
  session: unknown,
  replacedSessionEvents: ReplacedEventCounts,
): ClaudeCursorState | undefined {
  const usage = usageRows.toState();

  if (!usage) {
    return undefined;
  }

  return {
    plan: getClaudeReadPlanKey(plan),
    replaced: {
      ...(usage.openCount > 0 && { usage: usage.openCount }),
      ...replacedSessionEvents,
    },
    usage: usage.state,
    ...(session !== undefined && { session }),
  };
}
