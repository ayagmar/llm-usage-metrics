import path from 'node:path';

import {
  createMessageEvent,
  createSessionMetaEvent,
  createToolCallEvent,
  createUsageRecord,
  type EventKind,
  type SessionEvent,
  type SessionMetaFields,
  type ToolCallStatus,
  type UsageRecord,
} from '../../domain/session-event.js';
import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent, UsageEventInput } from '../../domain/usage-event.js';
import type { NumberLike } from '../../domain/normalization.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathExists } from '../../utils/fs-helpers.js';
import { readFirstLine } from '../../utils/read-first-line.js';
import { readClassifiedJsonlObjects, readJsonlObjects } from '../../utils/read-jsonl-objects.js';
import {
  discoverFilesAcrossRoots,
  isPathWithinRoots,
  resolveRootDirs,
} from '../multi-root-discovery.js';
import { createReadDiagnostics, recordSkippedRow } from '../parse-diagnostics.js';
import {
  asTrimmedText,
  hasPositiveUsageOrCostSignal,
  normalizeTimestampCandidate,
  resolveUsageTotalTokens,
  toNumberLike,
} from '../parsing-utils.js';
import {
  createKindEvent,
  joinTextBlocks,
  recordKindSkippedRow,
  recordMalformedLine,
  recordToolCallSkippedRow,
  resolveReadKinds,
  SessionMetaTracker,
  TimestampCarry,
  TOOL_CALL_REASONS,
  ToolCallPairing,
} from '../session-event-helpers.js';
import type {
  ReadEventsOptions,
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceReadDiagnostics,
  SourceReadOptions,
} from '../source-adapter.js';
import { createSourceContext, type SourceContext } from '../source-context.js';

function resolveDefaultPiRootDirs(context: SourceContext): string[] {
  return [
    path.join(context.homeDir, '.pi', 'agent', 'sessions'),
    path.join(context.homeDir, '.omp', 'agent', 'sessions'),
  ];
}

type PiSessionState = {
  sessionId?: string;
  sessionTimestamp?: string;
  /** Set for forked sessions. */
  fork?: PiFork;
  repoRoot?: string;
  provider?: string;
  model?: string;
};

type PiUsageExtract = {
  inputTokens?: NumberLike;
  outputTokens?: NumberLike;
  reasoningTokens?: NumberLike;
  cacheReadTokens?: NumberLike;
  cacheWriteTokens?: NumberLike;
  totalTokens?: NumberLike;
  costUsd?: NumberLike;
};

export type PiSourceAdapterOptions = SourceAdapterPathOptions & {
  /** Test seam: default roots scanned when no dir override is given. */
  defaultRootDirs?: string[];
};

const PI_MESSAGE_LINE_PATTERN = /"type"\s*:\s*"message"/u;
const PI_SESSION_LINE_PATTERN = /"type"\s*:\s*"session"/u;
const PI_MODEL_CHANGE_LINE_PATTERN = /"type"\s*:\s*"model_change"/u;

function shouldParsePiJsonlLine(lineText: string): boolean {
  return (
    PI_MESSAGE_LINE_PATTERN.test(lineText) ||
    PI_SESSION_LINE_PATTERN.test(lineText) ||
    PI_MODEL_CHANGE_LINE_PATTERN.test(lineText)
  );
}

const PI_SESSION_INFO_LINE_PATTERN = /"type"\s*:\s*"session_info"/u;

/** The union prefilter of a read that wants a kind other than usage. */
function shouldParsePiEventLine(lineText: string): boolean {
  return shouldParsePiJsonlLine(lineText) || PI_SESSION_INFO_LINE_PATTERN.test(lineText);
}

function resolveTimestamp(
  line: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
  state: PiSessionState,
): string | undefined {
  const candidates = [line.timestamp, message?.timestamp, state.sessionTimestamp];

  for (const candidate of candidates) {
    const normalizedTimestamp = normalizeTimestampCandidate(candidate);

    if (normalizedTimestamp) {
      return normalizedTimestamp;
    }
  }

  return undefined;
}

function resolveParentSessionPath(
  sessionLine: Record<string, unknown>,
  filePath: string,
): string | undefined {
  const parentSession = asTrimmedText(sessionLine.parentSession);
  return parentSession ? path.resolve(path.dirname(filePath), parentSession) : undefined;
}

async function readParentSessionPath(filePath: string): Promise<string | undefined> {
  // pi writes the session header as the first line; reading only that line keeps the
  // per-file cache-key check cheap on warm runs.
  const firstLine = await readFirstLine(filePath);

  if (!firstLine?.includes('"parentSession"')) {
    return undefined;
  }

  try {
    const header = asRecord(JSON.parse(firstLine));
    return header?.type === 'session' ? resolveParentSessionPath(header, filePath) : undefined;
  } catch {
    return undefined;
  }
}

/** Entries of a forked session older than its header were copied from the parent. */
type PiFork = {
  forkedAtMs: number;
  /** The same report counts the parent: it exists and lies under a discovery root. */
  parentCounted: boolean;
  /** Undefined when the parent's file name does not follow pi's naming. */
  parentSessionId?: string;
};

/** pi names a session file `<timestamp>_<session id>.jsonl`; other names give nothing. */
function getSessionIdFromPath(filePath: string): string | undefined {
  const baseName = path.basename(filePath, '.jsonl');
  const separator = baseName.lastIndexOf('_');
  const sessionId = separator === -1 ? '' : baseName.slice(separator + 1).trim();
  return sessionId || undefined;
}

/**
 * Copied entries are skipped while the report counts the parent. Otherwise the fork's
 * copies are the only live record of that usage, and they keep the parent's session id:
 * then they match the parent's events that history kept, which are not counted twice.
 */
async function resolveFork(
  sessionLine: Record<string, unknown>,
  filePath: string,
  rootDirs: readonly string[],
): Promise<PiFork | undefined> {
  const parentSessionPath = resolveParentSessionPath(sessionLine, filePath);
  const timestamp = normalizeTimestampCandidate(sessionLine.timestamp);

  if (!parentSessionPath || !timestamp) {
    return undefined;
  }

  return {
    forkedAtMs: Date.parse(timestamp),
    parentCounted:
      isPathWithinRoots(parentSessionPath, rootDirs) && (await pathExists(parentSessionPath)),
    parentSessionId: getSessionIdFromPath(parentSessionPath),
  };
}

function extractUsageFromRecord(usage: Record<string, unknown>): PiUsageExtract | undefined {
  const cost = asRecord(usage.cost);

  const extracted: PiUsageExtract = {
    inputTokens: toNumberLike(usage.input),
    outputTokens: toNumberLike(usage.output),
    reasoningTokens: toNumberLike(
      usage.reasoning ?? usage.reasoningTokens ?? usage.reasoningOutput ?? usage.outputReasoning,
    ),
    cacheReadTokens: toNumberLike(usage.cacheRead),
    cacheWriteTokens: toNumberLike(usage.cacheWrite),
    totalTokens: toNumberLike(usage.totalTokens),
    costUsd: toNumberLike(cost?.total),
  };

  const usageCandidates = [
    extracted.inputTokens,
    extracted.outputTokens,
    extracted.reasoningTokens,
    extracted.cacheReadTokens,
    extracted.cacheWriteTokens,
    extracted.totalTokens,
  ];

  return hasPositiveUsageOrCostSignal(usageCandidates, extracted.costUsd) ? extracted : undefined;
}

function extractUsage(line: Record<string, unknown>, message: Record<string, unknown> | undefined) {
  const lineUsage = asRecord(line.usage);
  const messageUsage = asRecord(message?.usage);

  if (lineUsage) {
    const extractedLineUsage = extractUsageFromRecord(lineUsage);

    if (extractedLineUsage) {
      return extractedLineUsage;
    }
  }

  if (!messageUsage) {
    return undefined;
  }

  return extractUsageFromRecord(messageUsage);
}

function applyModelChangeLine(line: Record<string, unknown>, state: PiSessionState): void {
  state.provider = asTrimmedText(line.provider) ?? state.provider;
  state.model = asTrimmedText(line.modelId) ?? asTrimmedText(line.model) ?? state.model;
  state.repoRoot = resolveRepoRootFromRecord(line) ?? state.repoRoot;
}

function resolveModel(
  line: Record<string, unknown>,
  message: Record<string, unknown> | undefined,
  state: PiSessionState,
): string | undefined {
  return (
    asTrimmedText(line.model) ??
    asTrimmedText(line.modelId) ??
    asTrimmedText(message?.model) ??
    state.model
  );
}

/**
 * The session id of a record's events. A fork copies the parent's entries (same ids and
 * timestamps) ahead of its own: undefined skips a copy while the parent is counted.
 */
function resolveRecordSessionId(state: PiSessionState, timestamp: string): string | undefined {
  const copiedFrom =
    state.fork && Date.parse(timestamp) < state.fork.forkedAtMs ? state.fork : undefined;

  if (copiedFrom?.parentCounted) {
    return undefined;
  }

  return copiedFrom?.parentSessionId ?? state.sessionId;
}

function getFallbackSessionId(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

function resolveRepoRootFromRecord(
  record: Record<string, unknown> | undefined,
): string | undefined {
  if (!record) {
    return undefined;
  }

  const pathRecord = asRecord(record.path);

  return (
    asTrimmedText(pathRecord?.root) ??
    asTrimmedText(pathRecord?.cwd) ??
    asTrimmedText(record.cwd) ??
    asTrimmedText(record.repo_root) ??
    asTrimmedText(record.repoRoot) ??
    asTrimmedText(record.project_root) ??
    asTrimmedText(record.projectRoot)
  );
}

type PiEventRequest = {
  kinds: ReadonlySet<EventKind>;
  text: boolean;
  raw: boolean;
};

function hasNonUsageKind(kinds: ReadonlySet<EventKind>): boolean {
  return kinds.size > (kinds.has('usage') ? 1 : 0);
}

const PI_TEXT_BLOCK_TYPES: ReadonlySet<string> = new Set(['text']);

type PiPendingToolCall = {
  sessionId: string;
  timestamp: string;
  toolCallId: string;
  name: string;
  messageId?: string;
  /** The call's record, only when the read asked for `raw`. */
  line?: Record<string, unknown>;
};

type PiToolResult = {
  status: ToolCallStatus;
  completedAt: string;
  durationMs?: number;
  line: Record<string, unknown>;
};

function toToolCallStatus(isError: unknown): ToolCallStatus {
  if (isError === true) {
    return 'error';
  }

  return isError === false ? 'ok' : 'unknown';
}

/**
 * The message, tool_call and session_meta events of a read that asks for them. It sees
 * every record the union prefilter passes, whichever of those kinds were requested.
 */
class PiSessionEvents {
  private readonly kinds: ReadonlySet<EventKind>;
  private readonly pairing: ToolCallPairing<PiPendingToolCall>;
  private readonly carry = new TimestampCarry<Record<string, unknown>>();
  // One tracker per session: a fork of an uncounted parent states the parent's facts
  // under the parent's id and its own under its id.
  private readonly metaTrackers = new Map<string, SessionMetaTracker>();

  public constructor(
    private readonly source: 'pi',
    private readonly filePath: string,
    private readonly diagnostics: SourceReadDiagnostics,
    private readonly request: PiEventRequest,
  ) {
    this.kinds = request.kinds;
    this.pairing = new ToolCallPairing(diagnostics, request.kinds);
  }

  /** The events a record completes, after those of records held for its timestamp. */
  public *add(line: Record<string, unknown>, state: PiSessionState): Generator<SessionEvent> {
    if (!isPiEventRecord(line)) {
      return;
    }

    const timestamp = resolveTimestamp(line, asRecord(line.message), state);

    if (timestamp) {
      for (const held of this.carry.advance(timestamp)) {
        yield* this.eventsAt(held, timestamp, state);
      }

      yield* this.eventsAt(line, timestamp, state);
      return;
    }

    const carried = this.carry.carry(line);

    if (carried) {
      yield* this.eventsAt(line, carried, state);
    }
  }

  /** At end of file: the calls never answered, then the records no timestamp reached. */
  public *finish(): Generator<SessionEvent> {
    for (const call of this.pairing.takeUnanswered()) {
      const event = this.createToolCall(call);

      if (event) {
        yield event;
      }
    }

    for (const line of this.carry.takeUnreleased()) {
      for (const kind of getStatedKinds(line)) {
        recordKindSkippedRow(this.diagnostics, this.kinds, kind, 'invalid_timestamp');
      }
    }
  }

  private *eventsAt(
    line: Record<string, unknown>,
    timestamp: string,
    state: PiSessionState,
  ): Generator<SessionEvent> {
    const sessionId = resolveRecordSessionId(state, timestamp);

    if (sessionId === undefined) {
      return;
    }

    switch (line.type) {
      case 'session': {
        const parentSessionPath = resolveParentSessionPath(line, this.filePath);
        yield* this.sessionMeta(line, sessionId, timestamp, {
          cwd: resolveRepoRootFromRecord(line),
          parentSessionId: parentSessionPath ? getSessionIdFromPath(parentSessionPath) : undefined,
        });
        return;
      }
      case 'model_change':
        yield* this.sessionMeta(line, sessionId, timestamp, {
          cwd: resolveRepoRootFromRecord(line),
          model: asTrimmedText(line.modelId) ?? asTrimmedText(line.model),
          rawProvider: asTrimmedText(line.provider),
        });
        return;
      case 'session_info':
        yield* this.sessionMeta(line, sessionId, timestamp, {
          title: asTrimmedText(line.name),
        });
        return;
      default:
        yield* this.messageEvents(line, sessionId, timestamp, state);
    }
  }

  private *sessionMeta(
    line: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    stated: SessionMetaFields,
  ): Generator<SessionEvent> {
    let tracker = this.metaTrackers.get(sessionId);

    if (!tracker) {
      tracker = new SessionMetaTracker(this.request.text);
      this.metaTrackers.set(sessionId, tracker);
    }

    const changes = tracker.changes(stated);

    if (!changes) {
      return;
    }

    const event = createKindEvent(this.diagnostics, this.kinds, 'session_meta', () =>
      createSessionMetaEvent({
        source: this.source,
        sessionId,
        timestamp,
        ...changes,
        raw: this.request.raw ? line : undefined,
      }),
    );

    if (event) {
      yield event;
    }
  }

  private *messageEvents(
    line: Record<string, unknown>,
    sessionId: string,
    timestamp: string,
    state: PiSessionState,
  ): Generator<SessionEvent> {
    const message = asRecord(line.message);
    const role = message?.role;

    if (role === 'toolResult') {
      const event = this.completeToolCall(line, message, timestamp);

      if (event) {
        yield event;
      }

      return;
    }

    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      return;
    }

    const messageId = role === 'assistant' ? asTrimmedText(message?.responseId) : undefined;
    const text = joinTextBlocks(message?.content, PI_TEXT_BLOCK_TYPES);

    if (text !== undefined) {
      const event = createKindEvent(this.diagnostics, this.kinds, 'message', () =>
        createMessageEvent({
          source: this.source,
          sessionId,
          timestamp,
          role,
          messageId,
          model: role === 'assistant' ? resolveModel(line, message, state) : undefined,
          textLength: text.length,
          text: this.request.text ? text : undefined,
          raw: this.request.raw ? line : undefined,
        }),
      );

      if (event) {
        yield event;
      }
    }

    if (role === 'assistant' && Array.isArray(message?.content)) {
      this.startToolCalls(line, message.content as unknown[], sessionId, timestamp, messageId);
    }
  }

  private startToolCalls(
    line: Record<string, unknown>,
    content: unknown[],
    sessionId: string,
    timestamp: string,
    messageId: string | undefined,
  ): void {
    for (const block of content) {
      const toolCall = asRecord(block);

      if (toolCall?.type !== 'toolCall') {
        continue;
      }

      const toolCallId = asTrimmedText(toolCall.id);
      const name = asTrimmedText(toolCall.name);

      if (!toolCallId || !name) {
        recordToolCallSkippedRow(
          this.diagnostics,
          this.kinds,
          toolCallId ? TOOL_CALL_REASONS.missingName : TOOL_CALL_REASONS.missingId,
        );
        continue;
      }

      this.pairing.start(toolCallId, {
        sessionId,
        timestamp,
        toolCallId,
        name,
        messageId,
        line: this.request.raw ? line : undefined,
      });
    }
  }

  private completeToolCall(
    line: Record<string, unknown>,
    message: Record<string, unknown> | undefined,
    timestamp: string,
  ): SessionEvent | undefined {
    const toolCallId = asTrimmedText(message?.toolCallId);

    if (!toolCallId) {
      recordToolCallSkippedRow(this.diagnostics, this.kinds, TOOL_CALL_REASONS.resultMissingId);
      return undefined;
    }

    const call = this.pairing.finish(toolCallId);

    return call
      ? this.createToolCall(call, {
          status: toToolCallStatus(message?.isError),
          completedAt: timestamp,
          durationMs: typeof message?.durationMs === 'number' ? message.durationMs : undefined,
          line,
        })
      : undefined;
  }

  private createToolCall(call: PiPendingToolCall, result?: PiToolResult): SessionEvent | undefined {
    return createKindEvent(this.diagnostics, this.kinds, 'tool_call', () =>
      createToolCallEvent({
        source: this.source,
        sessionId: call.sessionId,
        timestamp: call.timestamp,
        toolCallId: call.toolCallId,
        name: call.name,
        status: result?.status ?? 'unknown',
        completedAt: result?.completedAt,
        durationMs: result?.durationMs,
        messageId: call.messageId,
        raw: this.request.raw
          ? { call: call.line, ...(result && { result: result.line }) }
          : undefined,
      }),
    );
  }
}

function isPiEventRecord(line: Record<string, unknown>): boolean {
  return (
    line.type === 'message' ||
    line.type === 'session' ||
    line.type === 'model_change' ||
    line.type === 'session_info'
  );
}

/** The kinds a record would yield, to count it when no timestamp ever reached it. */
function getStatedKinds(line: Record<string, unknown>): Exclude<EventKind, 'usage'>[] {
  if (line.type !== 'message') {
    return ['session_meta'];
  }

  const message = asRecord(line.message);
  const role = message?.role;
  const kinds: Exclude<EventKind, 'usage'>[] = [];

  if (
    (role === 'user' || role === 'assistant' || role === 'system') &&
    joinTextBlocks(message?.content, PI_TEXT_BLOCK_TYPES) !== undefined
  ) {
    kinds.push('message');
  }

  if (
    role === 'assistant' &&
    Array.isArray(message?.content) &&
    (message.content as unknown[]).some((block) => asRecord(block)?.type === 'toolCall')
  ) {
    kinds.push('tool_call');
  }

  return kinds;
}

export class PiSourceAdapter implements SourceAdapter {
  public readonly id = 'pi' as const;
  public readonly parserVersion = 5;
  // Two forks of a deleted parent both keep its copied entries under the parent's id.
  public readonly capabilities = {
    eventsPrecedeFileMtime: true,
    eventsRepeatAcrossFiles: true,
    kinds: ['usage', 'message', 'tool_call', 'session_meta'],
  } as const;

  private readonly rootDirs: readonly string[];
  private readonly requireDir: boolean;

  public constructor(options: PiSourceAdapterOptions = {}) {
    this.rootDirs = resolveRootDirs(
      options.dir,
      options.defaultRootDirs ?? resolveDefaultPiRootDirs(options.context ?? createSourceContext()),
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
      directoryLabel: 'PI sessions directory',
      discoverInRoot: (rootDir) => discoverJsonlFiles(rootDir),
    });
  }

  public async getParseDependencies(filePath: string): Promise<string[]> {
    // Only a parent this adapter can discover changes the parse result (see
    // resolveForkedAtMs), so the dependency also keys the cache on that decision.
    const parentSessionPath = await readParentSessionPath(filePath);
    return parentSessionPath && isPathWithinRoots(parentSessionPath, this.rootDirs)
      ? [parentSessionPath]
      : [];
  }

  public read(filePath: string, options: SourceReadOptions = {}): AsyncGenerator<UsageEvent> {
    return this.parse(filePath, options.diagnostics ?? createReadDiagnostics());
  }

  public async *readEvents(
    filePath: string,
    options: ReadEventsOptions = {},
  ): AsyncGenerator<SessionEvent> {
    const kinds = resolveReadKinds(options.kinds, this.capabilities.kinds);

    if (kinds.size === 0) {
      return;
    }

    yield* this.parse(filePath, options.diagnostics ?? createReadDiagnostics(), {
      kinds,
      text: options.text ?? false,
      raw: options.raw ?? false,
    });
  }

  // One parser serves both reads. Without a request it is `read`: usage events only,
  // through the usage prefilter. A request for usage alone takes the same path and
  // yields usage records. Any other kind reads through the union prefilter, and the
  // usage branch still runs only on lines the usage prefilter accepts.
  private parse(filePath: string, diagnostics: SourceReadDiagnostics): AsyncGenerator<UsageEvent>;
  private parse(
    filePath: string,
    diagnostics: SourceReadDiagnostics,
    request: PiEventRequest,
  ): AsyncGenerator<SessionEvent>;
  private async *parse(
    filePath: string,
    diagnostics: SourceReadDiagnostics,
    request?: PiEventRequest,
  ): AsyncGenerator<UsageEvent | SessionEvent> {
    const state: PiSessionState = { sessionId: getFallbackSessionId(filePath) };

    if (!request || !hasNonUsageKind(request.kinds)) {
      for await (const line of readJsonlObjects(filePath, {
        shouldParseLine: shouldParsePiJsonlLine,
        onMalformedLine: () => {
          recordSkippedRow(diagnostics, 'json_parse_error');
        },
      })) {
        if (line.type === 'session') {
          await this.applySessionLine(line, filePath, state);
          continue;
        }

        if (line.type === 'model_change') {
          applyModelChangeLine(line, state);
          continue;
        }

        if (line.type !== 'message') {
          continue;
        }

        const event = this.createUsage(line, state, diagnostics, request);

        if (event) {
          yield event;
        }
      }

      return;
    }

    const { kinds } = request;
    const events = new PiSessionEvents(this.id, filePath, diagnostics, request);

    for await (const { record: line, isUsageLine } of readClassifiedJsonlObjects(filePath, {
      shouldParseLine: shouldParsePiEventLine,
      isUsageLine: shouldParsePiJsonlLine,
      onMalformedLine: (lineText) => {
        recordMalformedLine(diagnostics, kinds, shouldParsePiJsonlLine(lineText));
      },
    })) {
      if (isUsageLine && line.type === 'session') {
        await this.applySessionLine(line, filePath, state);
      } else if (isUsageLine && line.type === 'model_change') {
        applyModelChangeLine(line, state);
      }

      yield* events.add(line, state);

      if (isUsageLine && kinds.has('usage') && line.type === 'message') {
        const event = this.createUsage(line, state, diagnostics, request);

        if (event) {
          yield event;
        }
      }
    }

    yield* events.finish();
  }

  private async applySessionLine(
    line: Record<string, unknown>,
    filePath: string,
    state: PiSessionState,
  ): Promise<void> {
    state.sessionId = asTrimmedText(line.id) ?? state.sessionId;
    state.sessionTimestamp = asTrimmedText(line.timestamp) ?? state.sessionTimestamp;
    state.repoRoot = resolveRepoRootFromRecord(line) ?? state.repoRoot;
    state.fork = (await resolveFork(line, filePath, this.rootDirs)) ?? state.fork;
  }

  /** A message line's usage event for `read`, or its usage record for `readEvents`. */
  private createUsage(
    line: Record<string, unknown>,
    state: PiSessionState,
    diagnostics: SourceReadDiagnostics,
    request: PiEventRequest | undefined,
  ): UsageEvent | UsageRecord | undefined {
    const message = asRecord(line.message);
    const usage = extractUsage(line, message);

    if (!usage) {
      const hasUsageRecord = Boolean(asRecord(line.usage) ?? asRecord(message?.usage));

      if (hasUsageRecord) {
        recordSkippedRow(diagnostics, 'no_token_usage');
      }

      return undefined;
    }

    const provider =
      asTrimmedText(line.provider) ?? asTrimmedText(message?.provider) ?? state.provider;

    const timestamp = resolveTimestamp(line, message, state);

    if (!timestamp || !state.sessionId) {
      recordSkippedRow(diagnostics, 'invalid_timestamp');
      return undefined;
    }

    const sessionId = resolveRecordSessionId(state, timestamp);

    if (sessionId === undefined) {
      return undefined;
    }

    const input: UsageEventInput = {
      source: this.id,
      sessionId,
      timestamp,
      repoRoot:
        resolveRepoRootFromRecord(line) ?? resolveRepoRootFromRecord(message) ?? state.repoRoot,
      provider,
      model: resolveModel(line, message, state),
      ...usage,
      totalTokens: resolveUsageTotalTokens(usage),
    };

    try {
      return request
        ? createUsageRecord({
            ...input,
            messageId: asTrimmedText(message?.responseId),
            rawProvider: provider,
            raw: request.raw ? line : undefined,
          })
        : createUsageEvent(input);
    } catch {
      recordSkippedRow(diagnostics, 'event_creation_failed');
      return undefined;
    }
  }
}
