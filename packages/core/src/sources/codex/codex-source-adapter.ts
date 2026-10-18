import path from 'node:path';

import {
  createUsageRecord,
  type EventKind,
  type SessionEvent,
  type UsageRecord,
} from '../../domain/session-event.js';
import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent, UsageEventInput } from '../../domain/usage-event.js';
import { normalizeNonNegativeInteger } from '../../domain/normalization.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathStat } from '../../utils/fs-helpers.js';
import {
  readClassifiedJsonlObjectBatches,
  readJsonlObjectBatches,
} from '../../utils/read-jsonl-objects.js';
import { createReadDiagnostics, recordSkippedRow } from '../parse-diagnostics.js';
import {
  asTrimmedText,
  isBlankText,
  normalizeTimestampCandidate,
  splitPromptIncludingCachedTokens,
  toNumberLike,
} from '../parsing-utils.js';
import {
  getDeclaredKinds,
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
import { createSourceContext, readEnvPath, type SourceContext } from '../source-context.js';
import {
  CodexKindReader,
  resolveCodexRepoRoot,
  type CodexRecordContext,
} from './codex-session-events.js';

/** Codex keeps its state in CODEX_HOME (default ~/.codex); sessions live under it. */
export function resolveDefaultCodexSessionsDir(context: SourceContext): string {
  return path.join(
    readEnvPath(context, 'CODEX_HOME') ?? path.join(context.homeDir, '.codex'),
    'sessions',
  );
}

/**
 * Model name recorded for legacy Codex sessions that never name their model.
 *
 * @internal
 */
export const LEGACY_CODEX_MODEL_FALLBACK = 'legacy-codex-unknown';

type CodexUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

/** A per-response `token_usage_record` row waiting for the `token_count` that covers it. */
type PendingUsageRecord = {
  timestamp: string;
  usage: CodexUsage;
  repoRoot?: string;
  model?: string;
  /** The logged response id, kept only when the read asks for ids. */
  messageId?: string;
  /** The record whose tokens this is, kept only when the read asks for raw. */
  raw?: Record<string, unknown>;
};

type CodexSessionState = {
  sessionId: string;
  repoRoot?: string;
  provider?: string;
  model?: string;
  previousTotalUsage?: CodexUsage;
  previousLastUsageOnlyKey?: string;
  /** The provider as `session_meta` logged it; `provider` falls back to `openai`. */
  loggedProvider?: string;
  pendingUsageRecords: PendingUsageRecord[];
  seenResponseIds: Set<string>;
  /** Whether a `session_meta` line has been read; the first one is the file's own. */
  sawSessionMeta: boolean;
  /**
   * A fork's own thread id while its file is still replaying the parent's copied lines.
   * Set by a first `session_meta` that names `forked_from_id`, cleared by the
   * `thread_settings_applied` event that carries this id and ends the copied block.
   */
  forkPrefixOf?: string;
  /** Whether the fork's own `session_meta` names a Codex that logs every response's usage. */
  forkLogsUsageRecords?: boolean;
  /**
   * Set when such a fork's copied block ends without a running total. Codex still starts the fork
   * from the parent's totals, so a `token_count` written before the fork's first response
   * (a usage limit, a full context window, a compaction) repeats them.
   */
  forkAwaitsBaseline?: boolean;
};

/** What a usage record keeps beyond `read`'s fields; both are off for `read`. */
type UsageCapture = {
  ids: boolean;
  raw: boolean;
};

/** Options for `CodexSourceAdapter`. */
export type CodexSourceAdapterOptions = SourceAdapterPathOptions;

const SESSION_META_BYTES = Buffer.from('"session_meta"');
const TURN_CONTEXT_BYTES = Buffer.from('"turn_context"');
const EVENT_MSG_BYTES = Buffer.from('"event_msg"');
const TOKEN_COUNT_BYTES = Buffer.from('"token_count"');
const THREAD_SETTINGS_APPLIED_BYTES = Buffer.from('"thread_settings_applied"');
const THREAD_SETTINGS_APPLIED_PAYLOAD_BYTES = Buffer.from(
  ',"payload":{"type":"thread_settings_applied"',
);
const TOKEN_USAGE_RECORD_BYTES = Buffer.from('"token_usage_record"');
const TYPE_FIELD_BYTES = Buffer.from('"type":"');
const SESSION_META_TYPE_BYTES = Buffer.from('session_meta"');
const TURN_CONTEXT_TYPE_BYTES = Buffer.from('turn_context"');
const TOKEN_USAGE_RECORD_TYPE_BYTES = Buffer.from('token_usage_record"');
const EVENT_MSG_TYPE_BYTES = Buffer.from('event_msg"');
const RESPONSE_ITEM_BYTES = Buffer.from('"response_item"');
const RESPONSE_ITEM_TYPE_BYTES = Buffer.from('response_item"');

function shouldParseCodexJsonlLineBytes(lineBytes: Buffer): boolean {
  const typeFieldIndex = lineBytes.indexOf(TYPE_FIELD_BYTES);

  if (typeFieldIndex !== -1) {
    const typeValueIndex = typeFieldIndex + TYPE_FIELD_BYTES.length;

    if (
      lineBytesIncludesAt(lineBytes, SESSION_META_TYPE_BYTES, typeValueIndex) ||
      lineBytesIncludesAt(lineBytes, TURN_CONTEXT_TYPE_BYTES, typeValueIndex) ||
      lineBytesIncludesAt(lineBytes, TOKEN_USAGE_RECORD_TYPE_BYTES, typeValueIndex)
    ) {
      return true;
    }

    if (lineBytesIncludesAt(lineBytes, EVENT_MSG_TYPE_BYTES, typeValueIndex)) {
      return (
        lineBytes.includes(TOKEN_COUNT_BYTES, typeValueIndex) ||
        lineBytesIncludesAt(
          lineBytes,
          THREAD_SETTINGS_APPLIED_PAYLOAD_BYTES,
          typeValueIndex + EVENT_MSG_TYPE_BYTES.length,
        )
      );
    }

    return false;
  }

  if (
    lineBytes.includes(SESSION_META_BYTES) ||
    lineBytes.includes(TURN_CONTEXT_BYTES) ||
    lineBytes.includes(TOKEN_USAGE_RECORD_BYTES)
  ) {
    return true;
  }

  return (
    lineBytes.includes(EVENT_MSG_BYTES) &&
    (lineBytes.includes(TOKEN_COUNT_BYTES) || lineBytes.includes(THREAD_SETTINGS_APPLIED_BYTES))
  );
}

function lineBytesIncludesAt(
  lineBytes: Buffer,
  expectedBytes: Buffer,
  startIndex: number,
): boolean {
  if (startIndex + expectedBytes.length > lineBytes.length) {
    return false;
  }

  for (let index = 0; index < expectedBytes.length; index += 1) {
    if (lineBytes[startIndex + index] !== expectedBytes[index]) {
      return false;
    }
  }

  return true;
}

function toUsage(value: unknown): CodexUsage | undefined {
  const usage = asRecord(value);

  if (!usage) {
    return undefined;
  }

  // Codex input_tokens includes cached_input_tokens. We store net input separately
  // to avoid double counting input + cache read in reports and estimated pricing.
  const { inputTokens, cacheReadTokens } = splitPromptIncludingCachedTokens(
    normalizeNonNegativeInteger(toNumberLike(usage.input_tokens)),
    normalizeNonNegativeInteger(toNumberLike(usage.cached_input_tokens)),
  );
  const cacheWriteTokens = normalizeNonNegativeInteger(
    toNumberLike(usage.cache_write_input_tokens),
  );
  const outputTokens = normalizeNonNegativeInteger(toNumberLike(usage.output_tokens));

  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens: normalizeNonNegativeInteger(toNumberLike(usage.reasoning_output_tokens)),
    // Billable total excludes the reasoning breakdown: output_tokens already includes it.
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

function subtractUsage(current: CodexUsage, previous: CodexUsage): CodexUsage {
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cacheReadTokens: Math.max(0, current.cacheReadTokens - previous.cacheReadTokens),
    cacheWriteTokens: Math.max(0, current.cacheWriteTokens - previous.cacheWriteTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - previous.reasoningTokens),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
  };
}

function addUsage(left: CodexUsage, right: CodexUsage): CodexUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function hasUsageSignal(usage: CodexUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheWriteTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.reasoningTokens > 0 ||
    usage.totalTokens > 0
  );
}

function hasUsageRollback(current: CodexUsage, previous: CodexUsage): boolean {
  return (
    current.inputTokens < previous.inputTokens ||
    current.cacheReadTokens < previous.cacheReadTokens ||
    current.cacheWriteTokens < previous.cacheWriteTokens ||
    current.outputTokens < previous.outputTokens ||
    current.reasoningTokens < previous.reasoningTokens ||
    current.totalTokens < previous.totalTokens
  );
}

function deriveDeltaUsage(
  info: Record<string, unknown>,
  previousTotalUsage: CodexUsage | undefined,
): {
  deltaUsage?: CodexUsage;
  latestTotalUsage?: CodexUsage;
  fromLastUsageOnly?: boolean;
} {
  const totalUsage = toUsage(info.total_token_usage);
  const lastUsage = toUsage(info.last_token_usage);

  if (totalUsage && previousTotalUsage) {
    if (hasUsageRollback(totalUsage, previousTotalUsage)) {
      if (lastUsage && hasUsageSignal(lastUsage)) {
        return { deltaUsage: lastUsage, latestTotalUsage: totalUsage };
      }

      return {
        deltaUsage: hasUsageSignal(totalUsage) ? totalUsage : undefined,
        latestTotalUsage: totalUsage,
      };
    }

    const deltaFromTotals = subtractUsage(totalUsage, previousTotalUsage);

    if (hasUsageSignal(deltaFromTotals)) {
      return { deltaUsage: deltaFromTotals, latestTotalUsage: totalUsage };
    }

    // Duplicate token_count rows can repeat the last per-turn usage while totals stay unchanged.
    // Prefer totals and treat unchanged totals as no new usage signal.
    return { latestTotalUsage: totalUsage };
  }

  if (lastUsage) {
    return { deltaUsage: lastUsage, latestTotalUsage: totalUsage, fromLastUsageOnly: true };
  }

  if (!totalUsage) {
    return {};
  }

  const deltaUsage = previousTotalUsage
    ? subtractUsage(totalUsage, previousTotalUsage)
    : totalUsage;

  return { deltaUsage, latestTotalUsage: totalUsage };
}

function createLastUsageOnlyKey(timestamp: string, usage: CodexUsage): string {
  return [
    timestamp,
    usage.inputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ].join(':');
}

function getFallbackSessionId(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

// Newer Codex writes one `token_usage_record` per API response before the cumulative
// `token_count` event. The cumulative totals never include the response that triggered an
// auto-compaction (the `token_count` after `compacted` repeats the previous totals), so the
// records are the authoritative per-response accounting whenever a file has them: each
// `token_count` delta releases the records collected since the previous one, and records
// still pending at the end of the file (a compaction summary, or a response whose
// `token_count` is not written yet) are emitted as well. Files without records keep the
// delta accounting.
function parseUsageRecord(
  line: Record<string, unknown>,
  state: CodexSessionState,
  capture: UsageCapture,
  resolvedTimestamp: string | undefined,
): { record?: PendingUsageRecord; invalidTimestamp?: boolean } {
  const payload = asRecord(line.payload);
  const usage = toUsage(payload?.usage);

  if (!usage || !hasUsageSignal(usage)) {
    return {};
  }

  const responseId = asTrimmedText(payload?.response_id);

  if (responseId && state.seenResponseIds.has(responseId)) {
    return {};
  }

  const timestamp = resolvedTimestamp ?? normalizeTimestampCandidate(line.timestamp);

  if (!timestamp) {
    return { invalidTimestamp: true };
  }

  if (responseId) {
    state.seenResponseIds.add(responseId);
  }

  const record: PendingUsageRecord = {
    timestamp,
    usage,
    repoRoot: state.repoRoot,
    model: state.model,
  };

  if (capture.ids && responseId) {
    record.messageId = responseId;
  }

  if (capture.raw) {
    record.raw = line;
  }

  return { record };
}

const NO_USAGE: readonly PendingUsageRecord[] = [];

/** Codex logs a `token_usage_record` for every response from 0.153 on. */
function logsUsageRecords(cliVersion: string | undefined): boolean {
  const [major, minor] = (cliVersion ?? '').split('.').map(Number);
  return major > 0 || (major === 0 && minor >= 153);
}

function isThreadSettingsApplied(line: Record<string, unknown>): boolean {
  return line.type === 'event_msg' && asRecord(line.payload)?.type === 'thread_settings_applied';
}

/**
 * Takes one line the usage prefilter accepted into the session state, and returns the
 * usage records it releases, in order. `diagnostics` is undefined when the read yields no
 * usage, so it records no usage reason codes. `resolvedTimestamp` is the line's normalized
 * timestamp when the caller already has it.
 */
function takeUsageLine(
  line: Record<string, unknown>,
  state: CodexSessionState,
  capture: UsageCapture,
  diagnostics: SourceReadDiagnostics | undefined,
  resolvedTimestamp?: string,
): readonly PendingUsageRecord[] {
  if (line.type === 'session_meta') {
    if (state.forkPrefixOf !== undefined) {
      // An ancestor's session_meta, copied into the fork.
      return NO_USAGE;
    }

    const payload = asRecord(line.payload);

    if (!state.sawSessionMeta && asTrimmedText(payload?.forked_from_id)) {
      state.forkPrefixOf = asTrimmedText(payload?.id);
      state.forkLogsUsageRecords = logsUsageRecords(asTrimmedText(payload?.cli_version));
    }

    state.sawSessionMeta = true;
    const loggedProvider = asTrimmedText(payload?.model_provider);
    state.sessionId = asTrimmedText(payload?.id) ?? state.sessionId;
    state.provider = loggedProvider ?? state.provider;
    state.loggedProvider = loggedProvider ?? state.loggedProvider;
    state.repoRoot = resolveCodexRepoRoot(payload) ?? state.repoRoot;
    return NO_USAGE;
  }

  if (line.type === 'turn_context') {
    const payload = asRecord(line.payload);
    state.model = asTrimmedText(payload?.model) ?? state.model;
    state.repoRoot = resolveCodexRepoRoot(payload) ?? state.repoRoot;
    return NO_USAGE;
  }

  if (line.type === 'token_usage_record') {
    const { record, invalidTimestamp } = parseUsageRecord(line, state, capture, resolvedTimestamp);

    if (record) {
      state.pendingUsageRecords.push(record);
    } else if (invalidTimestamp && diagnostics) {
      recordSkippedRow(diagnostics, 'invalid_timestamp');
    }

    return NO_USAGE;
  }

  if (line.type !== 'event_msg') {
    return NO_USAGE;
  }

  const payload = asRecord(line.payload);

  if (payload?.type === 'thread_settings_applied') {
    if (state.forkPrefixOf !== undefined && payload.thread_id === state.forkPrefixOf) {
      // The copied block ends here. Its last running total stays the baseline for the
      // fork's own token_count lines; usage records it left pending are the parent's.
      state.forkPrefixOf = undefined;
      state.pendingUsageRecords = [];
      state.previousLastUsageOnlyKey = undefined;
      state.forkAwaitsBaseline =
        state.forkLogsUsageRecords === true && state.previousTotalUsage === undefined;
    }

    return NO_USAGE;
  }

  if (payload?.type !== 'token_count') {
    return NO_USAGE;
  }

  const info = asRecord(payload.info);

  if (!info) {
    return NO_USAGE;
  }

  if (state.forkAwaitsBaseline) {
    state.forkAwaitsBaseline = false;
    const totalUsage = toUsage(info.total_token_usage);

    // No response record since the copied block: these are the parent's totals.
    if (totalUsage && state.pendingUsageRecords.length === 0) {
      state.previousTotalUsage = totalUsage;
      return NO_USAGE;
    }
  }

  const { deltaUsage, latestTotalUsage, fromLastUsageOnly } = deriveDeltaUsage(
    info,
    state.previousTotalUsage,
  );

  if (!deltaUsage || !hasUsageSignal(deltaUsage)) {
    if (!fromLastUsageOnly) {
      state.previousLastUsageOnlyKey = undefined;
    }

    state.previousTotalUsage = latestTotalUsage ?? state.previousTotalUsage;
    return NO_USAGE;
  }

  const timestamp = resolvedTimestamp ?? normalizeTimestampCandidate(line.timestamp);

  if (!timestamp) {
    if (!fromLastUsageOnly) {
      state.previousLastUsageOnlyKey = undefined;
    }

    if (diagnostics) {
      recordSkippedRow(diagnostics, 'invalid_timestamp');
    }

    return NO_USAGE;
  }

  if (fromLastUsageOnly) {
    const currentLastUsageOnlyKey = createLastUsageOnlyKey(timestamp, deltaUsage);

    if (state.previousLastUsageOnlyKey === currentLastUsageOnlyKey) {
      return NO_USAGE;
    }

    state.previousLastUsageOnlyKey = currentLastUsageOnlyKey;
  } else {
    state.previousLastUsageOnlyKey = undefined;
  }

  let released: readonly PendingUsageRecord[];

  if (state.pendingUsageRecords.length > 0) {
    released = state.pendingUsageRecords;
    state.pendingUsageRecords = [];
  } else {
    const record: PendingUsageRecord = {
      timestamp,
      usage: deltaUsage,
      repoRoot: state.repoRoot,
      model: state.model,
    };

    if (capture.raw) {
      record.raw = line;
    }

    released = [record];
  }

  if (latestTotalUsage) {
    state.previousTotalUsage = latestTotalUsage;
  } else if (state.previousTotalUsage) {
    state.previousTotalUsage = addUsage(state.previousTotalUsage, deltaUsage);
  } else {
    state.previousTotalUsage = deltaUsage;
  }

  return released;
}

function shouldParseCodexEventLineBytes(lineBytes: Buffer): boolean {
  const typeFieldIndex = lineBytes.indexOf(TYPE_FIELD_BYTES);
  const isResponseItem =
    typeFieldIndex === -1
      ? lineBytes.includes(RESPONSE_ITEM_BYTES)
      : lineBytesIncludesAt(
          lineBytes,
          RESPONSE_ITEM_TYPE_BYTES,
          typeFieldIndex + TYPE_FIELD_BYTES.length,
        );

  return isResponseItem || shouldParseCodexJsonlLineBytes(lineBytes);
}

type CodexReadOptions<Usage> = UsageCapture & {
  /** The kinds the read yields; the usage state follows every line either way. */
  kinds: ReadonlySet<EventKind>;
  diagnostics: SourceReadDiagnostics;
  createUsage: (
    input: UsageEventInput,
    record: PendingUsageRecord,
    state: CodexSessionState,
  ) => Usage;
};

/** The non-usage kinds of a read, fed every parsed line after the usage state. */
type CodexKindEvents<Kind> = {
  advance(timestamp: string | undefined): Iterable<Kind>;
  record(line: Record<string, unknown>, context: CodexRecordContext): Iterable<Kind>;
  finish(): Iterable<Kind>;
};

const USAGE_ONLY: ReadonlySet<EventKind> = new Set(['usage']);

/** Codex CLI rollouts (JSONL), from `$CODEX_HOME/sessions` (default `~/.codex/sessions`). Yields every event kind. */
export class CodexSourceAdapter implements SourceAdapter {
  public readonly id = 'codex' as const;
  public readonly parserVersion = 3;
  public readonly capabilities = {
    fixedProviderRoots: ['openai'],
    eventsPrecedeFileMtime: true,
    kinds: ['usage', 'message', 'tool_call', 'session_meta'],
  } as const;

  private readonly sessionsDir: string;
  private readonly requireDir: boolean;

  public constructor(options: CodexSourceAdapterOptions = {}) {
    this.sessionsDir =
      options.dir ?? resolveDefaultCodexSessionsDir(options.context ?? createSourceContext());
    this.requireDir = options.requireDir ?? false;
  }

  public getSearchPaths(): string[] {
    return [this.sessionsDir].map((searchPath) => searchPath.trim());
  }

  public async discoverFiles(): Promise<string[]> {
    if (isBlankText(this.sessionsDir)) {
      throw new Error('Codex sessions directory must be a non-empty path');
    }

    const normalizedSessionsDir = this.sessionsDir.trim();

    if (this.requireDir) {
      const sessionsDirStats = await pathStat(normalizedSessionsDir);

      if (!sessionsDirStats) {
        throw new Error(
          `Codex sessions directory is missing or unreadable: ${normalizedSessionsDir}`,
        );
      }

      if (!sessionsDirStats.isDirectory()) {
        throw new Error(`Codex sessions directory is not a directory: ${normalizedSessionsDir}`);
      }
    }

    return discoverJsonlFiles(normalizedSessionsDir);
  }

  public read(filePath: string, options: SourceReadOptions = {}): AsyncGenerator<UsageEvent> {
    return this.readFile<UsageEvent, never>(
      filePath,
      {
        kinds: USAGE_ONLY,
        ids: false,
        raw: false,
        diagnostics: options.diagnostics ?? createReadDiagnostics(),
        createUsage: (input) => createUsageEvent(input),
      },
      undefined,
    );
  }

  public readEvents(
    filePath: string,
    options: ReadEventsOptions = {},
  ): AsyncGenerator<SessionEvent> {
    const kinds = resolveReadKinds(options.kinds, getDeclaredKinds(this));
    const diagnostics = options.diagnostics ?? createReadDiagnostics();
    const raw = options.raw === true;
    const createKindReader = [...kinds].some((kind) => kind !== 'usage')
      ? () => new CodexKindReader({ kinds, text: options.text === true, raw, diagnostics })
      : undefined;

    return this.readFile<UsageRecord, SessionEvent>(
      filePath,
      {
        kinds,
        ids: true,
        raw,
        diagnostics,
        createUsage: (input, record, state) =>
          createUsageRecord({
            ...input,
            messageId: record.messageId,
            rawProvider: state.loggedProvider,
            raw: record.raw,
          }),
      },
      createKindReader,
    );
  }

  // One parser for both reads. Without non-usage kinds it takes `read`'s prefilter and
  // per-line work. With them it reads through one union prefilter: the usage state takes
  // only the lines the usage prefilter accepts, and the kind reader sees every line after.
  //
  // A forked rollout starts with its own session_meta, then the parent's lines copied
  // with new timestamps, then the thread_settings_applied event carrying the fork's id.
  // Everything read between the two is held, with its own kind reader, and dropped at that
  // event. Forks written before Codex 0.152 have no such event; their held events are
  // yielded at the end of the file, so they count the copied lines as they did before.
  private async *readFile<Usage, Kind>(
    filePath: string,
    options: CodexReadOptions<Usage>,
    createKindReader: (() => CodexKindEvents<Kind>) | undefined,
  ): AsyncGenerator<Usage | Kind> {
    const { diagnostics, kinds } = options;

    if (kinds.size === 0) {
      return;
    }

    const yieldsUsage = kinds.has('usage');
    const usageDiagnostics = yieldsUsage ? diagnostics : undefined;

    const state: CodexSessionState = {
      sessionId: getFallbackSessionId(filePath),
      provider: 'openai',
      pendingUsageRecords: [],
      seenResponseIds: new Set(),
      sawSessionMeta: false,
    };

    // Released records take the session id and provider current at flush time.
    const toEvent = (record: PendingUsageRecord): Usage | undefined => {
      try {
        return options.createUsage(
          {
            source: 'codex',
            sessionId: state.sessionId,
            timestamp: record.timestamp,
            repoRoot: record.repoRoot,
            provider: state.provider,
            model: record.model ?? LEGACY_CODEX_MODEL_FALLBACK,
            inputTokens: record.usage.inputTokens,
            outputTokens: record.usage.outputTokens,
            reasoningTokens: record.usage.reasoningTokens,
            cacheReadTokens: record.usage.cacheReadTokens,
            cacheWriteTokens: record.usage.cacheWriteTokens,
            totalTokens: record.usage.totalTokens,
          },
          record,
          state,
        );
      } catch {
        recordSkippedRow(diagnostics, 'event_creation_failed');
        return undefined;
      }
    };

    const kindReader = createKindReader?.();
    // Set while a fork's copied lines are read: what they yield, and their kind reader.
    let held: (Usage | Kind)[] | undefined;
    let heldKindReader: CodexKindEvents<Kind> | undefined;

    // Starts or ends the hold after a line has updated the usage state.
    const followForkPrefix = (): void => {
      if (state.forkPrefixOf !== undefined && held === undefined) {
        held = [];
        heldKindReader = createKindReader?.();
      } else if (state.forkPrefixOf === undefined && held !== undefined) {
        held = undefined;
        heldKindReader = undefined;
      }
    };

    if (!kindReader) {
      for await (const lines of readJsonlObjectBatches(filePath, {
        shouldParseLineBytes: shouldParseCodexJsonlLineBytes,
        onMalformedLine: () => {
          recordSkippedRow(diagnostics, 'json_parse_error');
        },
      })) {
        for (const line of lines) {
          for (const record of takeUsageLine(line, state, options, diagnostics)) {
            const event = toEvent(record);

            if (event === undefined) {
              continue;
            }

            if (held) {
              held.push(event);
            } else {
              yield event;
            }
          }

          followForkPrefix();
        }
      }
    } else {
      for await (const items of readClassifiedJsonlObjectBatches(filePath, {
        shouldParseLineBytes: shouldParseCodexEventLineBytes,
        isUsageLineBytes: shouldParseCodexJsonlLineBytes,
        onMalformedLine: (lineBytes) => {
          recordMalformedLine(diagnostics, kinds, shouldParseCodexJsonlLineBytes(lineBytes));
        },
      })) {
        for (const { record: line, isUsageLine } of items) {
          if (isUsageLine && isThreadSettingsApplied(line)) {
            // Only the usage state reads it; the kind reader never saw these lines.
            takeUsageLine(line, state, options, usageDiagnostics);
            followForkPrefix();
            continue;
          }

          const lineKindReader = heldKindReader ?? kindReader;
          const timestamp = normalizeTimestampCandidate(line.timestamp);

          for (const event of lineKindReader.advance(timestamp)) {
            if (held) {
              held.push(event);
            } else {
              yield event;
            }
          }

          const released = isUsageLine
            ? takeUsageLine(line, state, options, usageDiagnostics, timestamp)
            : NO_USAGE;

          for (const record of yieldsUsage ? released : NO_USAGE) {
            const event = toEvent(record);

            if (event === undefined) {
              continue;
            }

            if (held) {
              held.push(event);
            } else {
              yield event;
            }
          }

          for (const event of lineKindReader.record(line, {
            sessionId: state.sessionId,
            model: state.model,
            timestamp,
          })) {
            if (held) {
              held.push(event);
            } else {
              yield event;
            }
          }

          followForkPrefix();
        }
      }

      if (held && heldKindReader) {
        held.push(...heldKindReader.finish());
      }
    }

    // A fork without the closing event: its held lines count as before.
    if (held) {
      yield* held;
    }

    if (kindReader) {
      yield* kindReader.finish();
    }

    for (const record of yieldsUsage ? state.pendingUsageRecords : NO_USAGE) {
      const event = toEvent(record);

      if (event !== undefined) {
        yield event;
      }
    }
  }
}
