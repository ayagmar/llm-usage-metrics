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
import {
  readJsonlFromStatefulCursor,
  ResumeConflict,
  type ReadResume,
  type StatefulJsonlPass,
} from '../../stream/cursor.js';
import { isOptionalString } from '../../stream/cursor-state.js';
import { asRecord } from '../../utils/as-record.js';
import { discoverJsonlFiles } from '../../utils/discover-jsonl-files.js';
import { pathExists } from '../../utils/fs-helpers.js';
import { readFirstLine } from '../../utils/read-first-line.js';
import {
  readClassifiedJsonlObjectBatches,
  readJsonlObjectBatches,
  type JsonlReadPosition,
} from '../../utils/read-jsonl-objects.js';
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
  SessionMetaTrackers,
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
import {
  parsePiCursorState,
  type PiCursorState,
  type PiFork,
  type PiSessionState,
} from './pi-cursor-state.js';

function resolveDefaultPiRootDirs(context: SourceContext): string[] {
  return [
    path.join(context.homeDir, '.pi', 'agent', 'sessions'),
    path.join(context.homeDir, '.omp', 'agent', 'sessions'),
  ];
}

type PiUsageExtract = {
  inputTokens?: NumberLike;
  outputTokens?: NumberLike;
  reasoningTokens?: NumberLike;
  cacheReadTokens?: NumberLike;
  cacheWriteTokens?: NumberLike;
  totalTokens?: NumberLike;
  costUsd?: NumberLike;
};

/** Options for `PiSourceAdapter`. */
export type PiSourceAdapterOptions = SourceAdapterPathOptions & {
  /** Test seam: default roots scanned when no dir override is given. @internal */
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

/** The read's options as a cursor state records them; `read` has no request. */
function getPiReadPlanKey(request: PiEventRequest | undefined): string {
  return request ? JSON.stringify([[...request.kinds].sort(), request.text, request.raw]) : 'read';
}

/** A read under a cursor: where it starts, and the state it resumes from. */
type PiResumablePass = {
  position: JsonlReadPosition;
  from?: PiCursorState;
  /** Receives the state to resume from next, or undefined when the next read restarts. */
  end: (state: PiCursorState | undefined) => void;
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

function toPendingToolCall(
  value: unknown,
): { callId: string; call: PiPendingToolCall } | undefined {
  const call = asRecord(value);
  const line = asRecord(call?.line);

  if (
    !call ||
    typeof call.sessionId !== 'string' ||
    typeof call.timestamp !== 'string' ||
    typeof call.toolCallId !== 'string' ||
    typeof call.name !== 'string' ||
    !isOptionalString(call.messageId) ||
    (call.line !== undefined && !line)
  ) {
    return undefined;
  }

  return {
    callId: call.toolCallId,
    call: {
      sessionId: call.sessionId,
      timestamp: call.timestamp,
      toolCallId: call.toolCallId,
      name: call.name,
      messageId: call.messageId,
      line,
    },
  };
}

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
  // A fork of an uncounted parent states the parent's facts under the parent's id and its
  // own under its id.
  private readonly meta: SessionMetaTrackers;

  /** `from`: under a cursor, the `toState` of the read before it; throws `ResumeConflict` when it does not check out. */
  public constructor(
    private readonly source: 'pi',
    private readonly filePath: string,
    private readonly diagnostics: SourceReadDiagnostics,
    private readonly request: PiEventRequest,
    from?: unknown,
  ) {
    this.kinds = request.kinds;
    this.pairing = new ToolCallPairing(diagnostics, request.kinds);
    this.meta = new SessionMetaTrackers(request.text);

    if (from !== undefined && !this.restoreState(from)) {
      throw new ResumeConflict();
    }
  }

  /**
   * What the records so far leave for the records after them, for a cursor; undefined
   * while a record waits for a timestamp. Take it before `finish`.
   */
  public toState(): unknown {
    const carry = this.carry.toState();
    return carry && { carry, pairing: this.pairing.toState(), meta: this.meta.toState() };
  }

  private restoreState(value: unknown): boolean {
    const state = asRecord(value);

    return (
      state !== undefined &&
      this.carry.restoreState(state.carry) &&
      this.pairing.restoreState(state.pairing, toPendingToolCall) &&
      this.meta.restoreState(state.meta)
    );
  }

  /**
   * The events a record completes, after those of records held for its timestamp.
   * `timestamp` is the record's own, as `resolveTimestamp` gives it.
   */
  public *add(
    line: Record<string, unknown>,
    state: PiSessionState,
    timestamp: string | undefined,
  ): Generator<SessionEvent> {
    if (!isPiEventRecord(line)) {
      return;
    }

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
      for (const kind of getStatedKinds(line, this.request.text)) {
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
    const changes = this.meta.changes(sessionId, stated);

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

/**
 * The kinds a record would yield, to count it when no timestamp ever reached it. A
 * `session_info` record states only a title, which a read without text never yields.
 */
function getStatedKinds(
  line: Record<string, unknown>,
  text: boolean | undefined,
): Exclude<EventKind, 'usage'>[] {
  if (line.type === 'session_info' && !text) {
    return [];
  }

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

/**
 * pi sessions (JSONL), from `~/.pi/agent/sessions` and `~/.omp/agent/sessions`. Yields every
 * event kind. A fork's events depend on its parent session, found under the same roots.
 * Incremental: honours `resume`, with its parse state in the cursor.
 */
export class PiSourceAdapter implements SourceAdapter {
  public readonly id = 'pi' as const;
  public readonly parserVersion = 5;
  // Two forks of a deleted parent both keep its copied entries under the parent's id.
  public readonly capabilities = {
    eventsPrecedeFileMtime: true,
    eventsRepeatAcrossFiles: true,
    kinds: ['usage', 'message', 'tool_call', 'session_meta'],
    incremental: true,
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
    const diagnostics = options.diagnostics ?? createReadDiagnostics();

    return options.resume
      ? this.readFromCursor(filePath, diagnostics, undefined, options.resume)
      : this.parse(filePath, diagnostics);
  }

  public readEvents(
    filePath: string,
    options: ReadEventsOptions = {},
  ): AsyncGenerator<SessionEvent> {
    const diagnostics = options.diagnostics ?? createReadDiagnostics();
    const request: PiEventRequest = {
      kinds: resolveReadKinds(options.kinds, this.capabilities.kinds),
      text: options.text ?? false,
      raw: options.raw ?? false,
    };

    return options.resume && request.kinds.has('usage')
      ? this.readFromCursor(filePath, diagnostics, request, options.resume)
      : this.parse(filePath, diagnostics, request);
  }

  private readFromCursor(
    filePath: string,
    diagnostics: SourceReadDiagnostics,
    request: undefined,
    resume: ReadResume,
  ): AsyncGenerator<UsageEvent>;
  private readFromCursor(
    filePath: string,
    diagnostics: SourceReadDiagnostics,
    request: PiEventRequest,
    resume: ReadResume,
  ): AsyncGenerator<SessionEvent>;
  private readFromCursor(
    filePath: string,
    diagnostics: SourceReadDiagnostics,
    request: PiEventRequest | undefined,
    resume: ReadResume,
  ): AsyncGenerator<UsageEvent | SessionEvent> {
    const planKey = getPiReadPlanKey(request);
    const pass = (
      position: JsonlReadPosition,
      passDiagnostics: SourceReadDiagnostics,
      from?: PiCursorState,
    ): StatefulJsonlPass<UsageEvent | SessionEvent> => {
      let endState: PiCursorState | undefined;
      const events = this.parse(filePath, passDiagnostics, request, {
        position,
        from,
        end: (state) => {
          endState = state;
        },
      });

      return { events, state: () => endState };
    };

    return readJsonlFromStatefulCursor(this, filePath, resume, diagnostics, {
      start: (position, passDiagnostics) => pass(position, passDiagnostics),
      restore: (value) => {
        const from = parsePiCursorState(value, planKey);

        return from
          ? {
              replaced: from.replaced,
              resume: (position, passDiagnostics) => pass(position, passDiagnostics, from),
            }
          : undefined;
      },
    });
  }

  // One parser serves both reads. Without a request it is `read`: usage events only,
  // through the usage prefilter. A request for usage alone takes the same path and
  // yields usage records, and a request for no kind yields nothing. Any other kind reads
  // through the union prefilter, and the usage branch still runs only on lines the usage
  // prefilter accepts. Under a cursor it starts where the cursor's state left off.
  private parse(filePath: string, diagnostics: SourceReadDiagnostics): AsyncGenerator<UsageEvent>;
  private parse(
    filePath: string,
    diagnostics: SourceReadDiagnostics,
    request: PiEventRequest,
  ): AsyncGenerator<SessionEvent>;
  private parse(
    filePath: string,
    diagnostics: SourceReadDiagnostics,
    request: PiEventRequest | undefined,
    resumable: PiResumablePass,
  ): AsyncGenerator<UsageEvent | SessionEvent>;
  private async *parse(
    filePath: string,
    diagnostics: SourceReadDiagnostics,
    request?: PiEventRequest,
    resumable?: PiResumablePass,
  ): AsyncGenerator<UsageEvent | SessionEvent> {
    if (request?.kinds.size === 0) {
      return;
    }

    const from = resumable?.from;
    const state: PiSessionState = from
      ? { ...from.session }
      : { sessionId: getFallbackSessionId(filePath) };
    const position = resumable?.position;

    if (!request || !hasNonUsageKind(request.kinds)) {
      for await (const lines of readJsonlObjectBatches(filePath, {
        shouldParseLine: shouldParsePiJsonlLine,
        onMalformedLine: () => {
          recordSkippedRow(diagnostics, 'json_parse_error');
        },
        position,
      })) {
        for (const line of lines) {
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
      }

      resumable?.end({ plan: getPiReadPlanKey(request), replaced: {}, session: state });
      return;
    }

    const { kinds } = request;
    const events = new PiSessionEvents(
      this.id,
      filePath,
      diagnostics,
      request,
      from && (from.events ?? null),
    );

    for await (const items of readClassifiedJsonlObjectBatches(filePath, {
      shouldParseLine: shouldParsePiEventLine,
      isUsageLine: shouldParsePiJsonlLine,
      onMalformedLine: (lineText) => {
        recordMalformedLine(diagnostics, kinds, shouldParsePiJsonlLine(lineText));
      },
      position,
    })) {
      for (const { record: line, isUsageLine } of items) {
        if (isUsageLine && line.type === 'session') {
          await this.applySessionLine(line, filePath, state);
        } else if (isUsageLine && line.type === 'model_change') {
          applyModelChangeLine(line, state);
        }

        // Resolved once for both branches: parsing it is a large part of a line's cost.
        const timestamp = resolveTimestamp(line, asRecord(line.message), state);

        for (const event of events.add(line, state, timestamp)) {
          yield event;
        }

        if (isUsageLine && kinds.has('usage') && line.type === 'message') {
          const event = this.createUsage(line, state, diagnostics, request, timestamp);

          if (event) {
            yield event;
          }
        }
      }
    }

    // Taken before `finish`, which yields the calls still waiting and then forgets them.
    const eventsState = resumable ? events.toState() : undefined;
    const skippedBeforeFinish = diagnostics.skippedRows;
    let unansweredCalls = 0;

    for (const event of events.finish()) {
      unansweredCalls += 1;
      yield event;
    }

    // A record counted at the end would be counted again by the next read.
    resumable?.end(
      eventsState && diagnostics.skippedRows === skippedBeforeFinish
        ? {
            plan: getPiReadPlanKey(request),
            replaced: unansweredCalls > 0 ? { tool_call: unansweredCalls } : {},
            session: state,
            events: eventsState,
          }
        : undefined,
    );
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

  /**
   * A message line's usage event for `read`, or its usage record for `readEvents`.
   * `resolvedTimestamp` is the line's timestamp when the caller already resolved it.
   */
  private createUsage(
    line: Record<string, unknown>,
    state: PiSessionState,
    diagnostics: SourceReadDiagnostics,
    request: PiEventRequest | undefined,
    resolvedTimestamp?: string,
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

    const timestamp = resolvedTimestamp ?? resolveTimestamp(line, message, state);

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
      singleRequest: true,
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
