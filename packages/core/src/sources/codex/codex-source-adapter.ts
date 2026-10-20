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
import { compareByCodePoint } from '../../utils/compare-by-code-point.js';
import { discoverFiles } from '../../utils/discover-files.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathStat } from '../../utils/fs-helpers.js';
import { hasErrorCode } from '../../utils/error-code.js';
import { readFirstLine } from '../../utils/read-first-line.js';
import { readParentVersion, type ParentVersion } from '../parent-version-cache.js';
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
  /** Whether the tokens are one response's: a usage record, or a delta equal to `last_token_usage`. */
  singleRequest: boolean;
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
   * The own thread id of a subagent spawned by a Codex before 0.153, until the read has
   * looked for a copy of its parent's turns: such a spawn can start with one without
   * naming `forked_from_id`.
   */
  spawnCandidateOf?: string;
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

/**
 * A `token_count` row's new usage. `last_token_usage` is the latest response's usage, so
 * new usage equal to it covers that one response; a delta of running totals that differs
 * from it spans several responses (rows Codex did not write, or wrote without info).
 */
function deriveDeltaUsage(
  info: Record<string, unknown>,
  previousTotalUsage: CodexUsage | undefined,
): {
  deltaUsage?: CodexUsage;
  latestTotalUsage?: CodexUsage;
  fromLastUsageOnly?: boolean;
  singleRequest: boolean;
} {
  const derived = deriveDeltaFromTotals(info, previousTotalUsage);
  const lastUsage = toUsage(info.last_token_usage);
  const singleRequest =
    derived.deltaUsage !== undefined &&
    lastUsage !== undefined &&
    createUsageKey(derived.deltaUsage) === createUsageKey(lastUsage);

  return { ...derived, singleRequest };
}

function deriveDeltaFromTotals(
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

function createUsageKey(usage: CodexUsage): string {
  return [
    usage.inputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ].join(':');
}

function createLastUsageOnlyKey(timestamp: string, usage: CodexUsage): string {
  return `${timestamp}:${createUsageKey(usage)}`;
}

const COMPRESSED_ROLLOUT_SUFFIX = '.zst';

/** A rollout's file name without `.jsonl` or `.jsonl.zst`. */
function getRolloutStem(filePath: string): string {
  return path.basename(path.basename(filePath, COMPRESSED_ROLLOUT_SUFFIX), '.jsonl');
}

/**
 * Codex compresses rollouts it no longer writes to `<name>.jsonl.zst`, and decompresses one
 * back to `<name>.jsonl` to append to it. While both exist, the plain file is the rollout,
 * as Codex reads it, so a session is never read twice.
 */
async function discoverRollouts(rootDir: string): Promise<string[]> {
  const plainFiles = await discoverJsonlFiles(rootDir);
  const plainFileSet = new Set(plainFiles);
  const compressedFiles = (
    await discoverFiles(rootDir, { extension: `.jsonl${COMPRESSED_ROLLOUT_SUFFIX}` })
  ).filter((filePath) => !plainFileSet.has(filePath.slice(0, -COMPRESSED_ROLLOUT_SUFFIX.length)));

  return [...plainFiles, ...compressedFiles].sort(compareByCodePoint);
}

function getFallbackSessionId(filePath: string): string {
  return getRolloutStem(filePath);
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
    singleRequest: true,
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

/**
 * Codex 0.120 to 0.134 spawn forked subagents (`fork_turns`) that copy their parent's last
 * turns but name no `forked_from_id`; from 0.135 a forked subagent names it.
 */
function spawnsCopiedSubagents(cliVersion: string | undefined): boolean {
  const [major, minor] = (cliVersion ?? '').split('.').map(Number);
  return major === 0 && minor >= 120 && minor <= 134;
}

function isThreadSettingsApplied(line: Record<string, unknown>): boolean {
  return line.type === 'event_msg' && asRecord(line.payload)?.type === 'thread_settings_applied';
}

/** Ends a fork's copied block: what it left pending is the parent's. */
function endForkPrefix(state: CodexSessionState): void {
  state.forkPrefixOf = undefined;
  state.pendingUsageRecords = [];
  state.previousLastUsageOnlyKey = undefined;
  state.forkAwaitsBaseline =
    state.forkLogsUsageRecords === true && state.previousTotalUsage === undefined;
}

const USER_ROLE_BYTES = Buffer.from('"role":"user"');
const ASSISTANT_ROLE_BYTES = Buffer.from('"role":"assistant"');
const ASSISTANT_SIGNATURE_PREFIX = 'assistant:';

/**
 * The lines that tell a fork's copied block from its own: usage lines, and user and
 * assistant messages.
 */
function shouldParseCopyLineBytes(lineBytes: Buffer): boolean {
  return (
    shouldParseCodexJsonlLineBytes(lineBytes) ||
    (lineBytes.includes(RESPONSE_ITEM_BYTES) &&
      (lineBytes.includes(USER_ROLE_BYTES) || lineBytes.includes(ASSISTANT_ROLE_BYTES)))
  );
}

/**
 * What a copied line keeps from the parent's: a `token_count`'s running total, or a user
 * or assistant message's content. Undefined for any other line. Copies carry new
 * timestamps and are written again by the fork's Codex, so only these values are compared.
 */
function getCopySignature(line: Record<string, unknown>): string | undefined {
  const payload = asRecord(line.payload);

  if (line.type === 'response_item') {
    return payload?.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')
      ? `${payload.role}:${JSON.stringify(payload.content)}`
      : undefined;
  }

  const info =
    line.type === 'event_msg' && payload?.type === 'token_count'
      ? asRecord(payload.info)
      : undefined;
  const totalUsage = info && toUsage(info.total_token_usage);
  return info && `total:${totalUsage ? createUsageKey(totalUsage) : ''}`;
}

/**
 * Codex names a rollout `rollout-<time>-<thread id>.jsonl` (`.jsonl.zst` once compressed);
 * the id is a 36-character UUID.
 */
function getRolloutThreadId(filePath: string): string | undefined {
  const name = getRolloutStem(filePath);
  return name.length > 37 && name[name.length - 37] === '-' ? name.slice(-36) : undefined;
}

function indexRolloutsByThreadId(filePaths: readonly string[]): Map<string, string> {
  const rollouts = new Map<string, string>();

  for (const filePath of filePaths) {
    const threadId = getRolloutThreadId(filePath);

    if (threadId && !rollouts.has(threadId)) {
      rollouts.set(threadId, filePath);
    }
  }

  return rollouts;
}

/** The parent of a subagent's `session_meta` (`source.subagent.thread_spawn`). */
function getSpawnParentThreadId(payload: Record<string, unknown> | undefined): string | undefined {
  const subagent = asRecord(asRecord(payload?.source)?.subagent);
  return asTrimmedText(asRecord(subagent?.thread_spawn)?.parent_thread_id);
}

/** A rollout that may start with a copy of its parent's lines, from its first line. */
type ForkHeader = { forkId: string; parentThreadId: string };

/**
 * The fork's own id and its parent's, for a fork written before Codex 0.153 or a subagent
 * spawned with a copy (see `spawnsCopiedSubagents`), from the file's first line. Later
 * forks end their copied block with a marker and never need the parent.
 */
async function readForkHeader(filePath: string): Promise<ForkHeader | undefined> {
  const firstLine = await readFirstLine(filePath);

  if (!firstLine?.includes('"forked_from_id"') && !firstLine?.includes('"parent_thread_id"')) {
    return undefined;
  }

  try {
    const line = asRecord(JSON.parse(firstLine));
    const payload = line?.type === 'session_meta' ? asRecord(line.payload) : undefined;
    const forkId = asTrimmedText(payload?.id);
    const cliVersion = asTrimmedText(payload?.cli_version);
    const parentThreadId = logsUsageRecords(cliVersion)
      ? undefined
      : (asTrimmedText(payload?.forked_from_id) ??
        (spawnsCopiedSubagents(cliVersion) ? getSpawnParentThreadId(payload) : undefined));

    return forkId && parentThreadId ? { forkId, parentThreadId } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a fork's own `thread_settings_applied` event ends its copied block. */
async function hasOwnClosingEvent(filePath: string, forkId: string): Promise<boolean> {
  for await (const lines of readJsonlObjectBatches(filePath, {
    shouldParseLineBytes: shouldParseCodexJsonlLineBytes,
  })) {
    for (const line of lines) {
      if (isThreadSettingsApplied(line) && asRecord(line.payload)?.thread_id === forkId) {
        return true;
      }
    }
  }

  return false;
}

/** The copy signatures of a rollout's lines, in file order. */
async function readCopySignatures(filePath: string): Promise<string[]> {
  const signatures: string[] = [];

  for await (const lines of readJsonlObjectBatches(filePath, {
    shouldParseLineBytes: shouldParseCopyLineBytes,
  })) {
    for (const line of lines) {
      const signature = getCopySignature(line);

      if (signature !== undefined) {
        signatures.push(signature);
      }
    }
  }

  return signatures;
}

/**
 * Where a fork's copied block ends, given its parent's copy signatures: the index, among
 * the lines the usage prefilter accepts, of the last `token_count` copied from the parent.
 * Codex copies one contiguous run of the parent's lines (all of them, those before a chosen
 * user message, or a forked subagent's last turns), keeping every `token_count` and user
 * message in it; a forked subagent keeps only final assistant messages. So the copies are
 * the fork's first signatures, matching a run of the parent's one for one, where only the
 * parent's assistant messages may be skipped, and the first fork line that breaks every
 * such run is the fork's own. Its own turn has its own model response, so it breaks the run
 * even when it repeats the parent's next prompt and reaches the same running total.
 * Undefined when nothing matches.
 */
async function findCopiedPrefixEnd(
  filePath: string,
  parentSignatures: readonly string[],
): Promise<number | undefined> {
  let usageLineIndex = -1;
  // Where each run of the parent's signatures that still matches expects the next one.
  let nextParentIndexes: number[] | undefined;
  let copiedPrefixEnd: number | undefined;
  // The index of `signature` at or after `index`, past assistant messages the copy left out.
  const matchFrom = (index: number, signature: string): number | undefined => {
    let parentIndex = index;

    while (
      parentSignatures[parentIndex] !== signature &&
      parentSignatures[parentIndex]?.startsWith(ASSISTANT_SIGNATURE_PREFIX)
    ) {
      parentIndex += 1;
    }

    return parentSignatures[parentIndex] === signature ? parentIndex : undefined;
  };

  for await (const items of readClassifiedJsonlObjectBatches(filePath, {
    shouldParseLineBytes: shouldParseCopyLineBytes,
    isUsageLineBytes: shouldParseCodexJsonlLineBytes,
  })) {
    for (const { record: line, isUsageLine } of items) {
      if (isUsageLine) {
        usageLineIndex += 1;
      }

      const signature = getCopySignature(line);

      if (signature === undefined) {
        continue;
      }

      nextParentIndexes =
        nextParentIndexes === undefined
          ? parentSignatures.flatMap((parentSignature, index) =>
              parentSignature === signature ? [index + 1] : [],
            )
          : nextParentIndexes.flatMap((index) => {
              const matchIndex = matchFrom(index, signature);
              return matchIndex === undefined ? [] : [matchIndex + 1];
            });

      if (nextParentIndexes.length === 0) {
        return copiedPrefixEnd;
      }

      if (isUsageLine) {
        copiedPrefixEnd = usageLineIndex;
      }
    }
  }

  return copiedPrefixEnd;
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
    } else if (
      !state.sawSessionMeta &&
      getSpawnParentThreadId(payload) &&
      spawnsCopiedSubagents(asTrimmedText(payload?.cli_version))
    ) {
      state.spawnCandidateOf = asTrimmedText(payload?.id);
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
      // fork's own token_count lines.
      endForkPrefix(state);
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

  const { deltaUsage, latestTotalUsage, fromLastUsageOnly, singleRequest } = deriveDeltaUsage(
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
      singleRequest,
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
  public readonly parserVersion = 6;
  public readonly capabilities = {
    fixedProviderRoots: ['openai'],
    eventsPrecedeFileMtime: true,
    // A fork's parent is looked up by the id in its first line. A fork whose parent is not
    // found depends on a path that never exists, so its stored entry is never reused.
    dependenciesFollowFile: true,
    kinds: ['usage', 'message', 'tool_call', 'session_meta'],
  } as const;

  private readonly sessionsDir: string;
  private readonly requireDir: boolean;
  /** Rollouts by thread id, read once when a file first needs its parent. */
  private rolloutsByThreadId: Promise<Map<string, string>> | undefined;
  /** Parents' copy signatures, read once per version of each parent. */
  private readonly parentSignaturesByPath = new Map<string, ParentVersion<string[]>>();

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

    return discoverRollouts(normalizedSessionsDir);
  }

  public async getParseDependencies(filePath: string): Promise<string[]> {
    const parent = await this.resolveForkParent(filePath);

    // A parent not found is declared by a path that never exists: the fork's entry is then
    // never confirmed from the store, so a parent that turns up later is found.
    return parent
      ? [parent.path ?? path.join(this.sessionsDir.trim(), `.missing-parent-${parent.threadId}`)]
      : [];
  }

  /**
   * The parent of a fork that needs it to find its copied block (see `readForkHeader`), and
   * has no closing event of its own. Its path is set when it lies under the sessions
   * directory or, for a `sessions` directory in a Codex home, in the `archived_sessions`
   * directory next to it, where Codex moves an archived thread.
   */
  private async resolveForkParent(
    filePath: string,
  ): Promise<{ threadId: string; path?: string } | undefined> {
    const header = await readForkHeader(filePath);

    if (
      !header ||
      isBlankText(this.sessionsDir) ||
      (await hasOwnClosingEvent(filePath, header.forkId))
    ) {
      return undefined;
    }

    this.rolloutsByThreadId ??= this.indexRollouts();
    return {
      threadId: header.parentThreadId,
      path: (await this.rolloutsByThreadId).get(header.parentThreadId),
    };
  }

  private async indexRollouts(): Promise<Map<string, string>> {
    const sessionsDir = this.sessionsDir.trim();
    const files = await discoverRollouts(sessionsDir);

    if (path.basename(sessionsDir) === 'sessions') {
      files.push(
        ...(await discoverRollouts(path.join(path.dirname(sessionsDir), 'archived_sessions'))),
      );
    }

    return indexRolloutsByThreadId(files);
  }

  private async findForkPrefixEnd(filePath: string): Promise<number | undefined> {
    const parentPath = (await this.resolveForkParent(filePath))?.path;

    if (!parentPath) {
      return undefined;
    }

    let parentSignatures: string[] | undefined;

    try {
      parentSignatures = await readParentVersion(
        parentPath,
        this.parentSignaturesByPath,
        readCopySignatures,
      );
    } catch (error) {
      // A parent removed since discovery reads as a missing one. Any other failure fails
      // the fork's parse, so nothing is stored and the next run reads it again.
      if (hasErrorCode(error, 'ENOENT')) {
        return undefined;
      }

      throw error;
    }

    return parentSignatures && findCopiedPrefixEnd(filePath, parentSignatures);
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
  // event. Forks written before Codex 0.153 may have no such event: their copied block ends
  // at the last token_count copied from the parent (see findCopiedPrefixEnd), so the parent
  // must be found (see resolveForkParentPath). Without it, their held events are yielded at
  // the end of the file, so they count the copied lines as they did before. A subagent such
  // a Codex spawned may copy its parent's last turns without naming forked_from_id; it is
  // held from its first line only when that copy is found.
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
            singleRequest: record.singleRequest,
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
    // The index of the current line among those the usage prefilter accepts, and that of
    // the last line a fork without the closing event copied from its parent, once known.
    let usageLineIndex = -1;
    let copiedPrefixEnd: number | undefined;

    // Starts or ends the hold after a line has updated the usage state. Returns true when
    // the caller must look for a copied block: the hold starts, or a spawned subagent
    // may start with a copy.
    const followForkPrefix = (): boolean => {
      if (state.forkPrefixOf !== undefined && usageLineIndex === copiedPrefixEnd) {
        endForkPrefix(state);
      }

      if (state.forkPrefixOf !== undefined && held === undefined) {
        held = [];
        heldKindReader = createKindReader?.();
        return true;
      }

      if (state.forkPrefixOf === undefined && held !== undefined) {
        held = undefined;
        heldKindReader = undefined;
      }

      return state.spawnCandidateOf !== undefined;
    };

    // Finds where the copied block ends. A spawned subagent holds its lines only when its
    // parent's copy is found at its top; otherwise it reads as any session.
    const findCopiedBlock = async (): Promise<void> => {
      const spawnId = state.spawnCandidateOf;
      state.spawnCandidateOf = undefined;
      copiedPrefixEnd = await this.findForkPrefixEnd(filePath);

      if (spawnId !== undefined && copiedPrefixEnd !== undefined) {
        state.forkPrefixOf = spawnId;
        followForkPrefix();
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
          usageLineIndex += 1;

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

          if (followForkPrefix()) {
            await findCopiedBlock();
          }
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
          if (isUsageLine) {
            usageLineIndex += 1;
          }

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

          if (followForkPrefix()) {
            await findCopiedBlock();
          }
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
