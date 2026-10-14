import {
  createMessageEvent,
  createSessionMetaEvent,
  createToolCallEvent,
  type EventKind,
  type MessageEvent,
  type SessionEvent,
  type SessionMetaFields,
  type ToolCallStatus,
} from '../../domain/session-event.js';
import { asRecord } from '../../utils/as-record.js';
import {
  createKindEvent,
  joinTextBlocks,
  recordKindSkippedRow,
  recordToolCallSkippedRow,
  SessionMetaTracker,
  TimestampCarry,
  TOOL_CALL_REASONS,
  ToolCallPairing,
} from '../session-event-helpers.js';
import { asTrimmedText } from '../parsing-utils.js';
import type { SourceReadDiagnostics } from '../source-adapter.js';

/** What the usage state says about the session when a record is read. */
export type CodexRecordContext = {
  sessionId: string;
  model?: string;
  /** A valid timestamp from the record itself; undefined when it has none. */
  timestamp?: string;
};

type CodexKindReaderOptions = {
  kinds: ReadonlySet<EventKind>;
  text: boolean;
  raw: boolean;
  diagnostics: SourceReadDiagnostics;
};

type ToolCallResult = {
  status: ToolCallStatus;
  completedAt?: string;
  record: Record<string, unknown>;
};

type PendingToolCall = {
  sessionId: string;
  timestamp?: string;
  toolCallId?: string;
  name: string;
  call: Record<string, unknown>;
  /** Set once the result is seen; the call waits for a timestamp to be yielded. */
  result?: ToolCallResult;
};

type HeldEvent = {
  kind: Exclude<EventKind, 'usage'>;
  release: (timestamp: string) => SessionEvent | undefined;
};

const CODEX_TEXT_BLOCK_TYPES: ReadonlySet<string> = new Set(['input_text', 'output_text']);

// User messages Codex writes itself rather than the person typing: workspace context,
// instructions, skill bodies and harness notices. They are system messages.
const INJECTED_CONTEXT_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '# AGENTS.md instructions',
  '<skill>',
  '<turn_aborted>',
  '<user_action>',
  '<user_shell_command>',
];

// A Map, so a logged role such as "constructor" finds no inherited value.
const MESSAGE_ROLES: ReadonlyMap<string, MessageEvent['role']> = new Map([
  ['user', 'user'],
  ['assistant', 'assistant'],
  ['developer', 'system'],
]);

const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call']);
const TOOL_RESULT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);
const WEB_SEARCH_TOOL_NAME = 'web_search';

function isInjectedContext(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }

  let textBlocks = 0;

  for (const block of content as unknown[]) {
    const { type, text } = asRecord(block) ?? {};

    if (typeof type !== 'string' || !CODEX_TEXT_BLOCK_TYPES.has(type) || typeof text !== 'string') {
      continue;
    }

    const start = text.trimStart();

    if (!INJECTED_CONTEXT_PREFIXES.some((prefix) => start.startsWith(prefix))) {
      return false;
    }

    textBlocks += 1;
  }

  return textBlocks > 0;
}

function toWebSearchStatus(status: unknown): ToolCallStatus {
  if (status === 'completed') {
    return 'ok';
  }

  return status === 'failed' ? 'error' : 'unknown';
}

/**
 * The message, tool_call and session_meta kinds of one Codex file. The adapter hands it
 * every record a non-usage read parses, after the usage state has taken the record in;
 * `kinds` only gates what is yielded.
 */
export class CodexKindReader {
  private readonly kinds: ReadonlySet<EventKind>;
  private readonly text: boolean;
  private readonly raw: boolean;
  private readonly diagnostics: SourceReadDiagnostics;
  private readonly pairing: ToolCallPairing<PendingToolCall>;
  private readonly meta: SessionMetaTracker;
  private readonly carry = new TimestampCarry<HeldEvent>();

  public constructor(options: CodexKindReaderOptions) {
    this.kinds = options.kinds;
    this.text = options.text;
    this.raw = options.raw;
    this.diagnostics = options.diagnostics;
    this.pairing = new ToolCallPairing(options.diagnostics, options.kinds);
    this.meta = new SessionMetaTracker(options.text);
  }

  /** Events held for a timestamp, released by a record that has one, ahead of its own. */
  public *advance(timestamp: string | undefined): Generator<SessionEvent> {
    if (timestamp === undefined) {
      return;
    }

    for (const held of this.carry.advance(timestamp)) {
      const event = held.release(timestamp);

      if (event) {
        yield event;
      }
    }
  }

  public *record(
    line: Record<string, unknown>,
    context: CodexRecordContext,
  ): Generator<SessionEvent> {
    const payload = asRecord(line.payload);

    if (!payload) {
      return;
    }

    if (line.type === 'session_meta') {
      yield* this.sessionMeta(line, context, {
        cwd: resolveCodexRepoRoot(payload),
        agentVersion: asTrimmedText(payload.cli_version),
        gitBranch: asTrimmedText(asRecord(payload.git)?.branch),
        rawProvider: asTrimmedText(payload.model_provider),
      });
      return;
    }

    if (line.type === 'turn_context') {
      yield* this.sessionMeta(line, context, {
        cwd: resolveCodexRepoRoot(payload),
        model: asTrimmedText(payload.model),
      });
      return;
    }

    if (line.type !== 'response_item' || typeof payload.type !== 'string') {
      return;
    }

    if (payload.type === 'message') {
      yield* this.message(line, payload, context);
    } else if (TOOL_CALL_TYPES.has(payload.type)) {
      this.startToolCall(line, payload, context);
    } else if (TOOL_RESULT_TYPES.has(payload.type)) {
      yield* this.finishToolCall(line, payload, context);
    } else if (payload.type === 'web_search_call') {
      yield* this.webSearch(line, payload, context);
    }
  }

  /** At end of file: unanswered calls, then a count of what never got a timestamp. */
  public *finish(): Generator<SessionEvent> {
    for (const call of this.pairing.takeUnanswered()) {
      // A call without a timestamp is still held, and counted below.
      if (call.timestamp !== undefined) {
        const event = this.toolCallEvent(call, call.timestamp);

        if (event) {
          yield event;
        }
      }
    }

    for (const held of this.carry.takeUnreleased()) {
      recordKindSkippedRow(this.diagnostics, this.kinds, held.kind, 'invalid_timestamp');
    }
  }

  /** Yields `build` at the record's timestamp, the carried one, or once one is seen. */
  private *atTimestamp(
    kind: Exclude<EventKind, 'usage'>,
    timestamp: string | undefined,
    build: (timestamp: string) => SessionEvent | undefined,
  ): Generator<SessionEvent> {
    const resolved = timestamp ?? this.carry.carry({ kind, release: build });

    if (resolved === undefined) {
      return;
    }

    const event = build(resolved);

    if (event) {
      yield event;
    }
  }

  private *sessionMeta(
    line: Record<string, unknown>,
    { sessionId, timestamp }: CodexRecordContext,
    stated: SessionMetaFields,
  ): Generator<SessionEvent> {
    const changes = this.meta.changes(stated);

    if (!changes) {
      return;
    }

    yield* this.atTimestamp('session_meta', timestamp, (resolved) =>
      createKindEvent(this.diagnostics, this.kinds, 'session_meta', () =>
        createSessionMetaEvent({
          source: 'codex',
          sessionId,
          timestamp: resolved,
          ...changes,
          raw: this.raw ? line : undefined,
        }),
      ),
    );
  }

  private *message(
    line: Record<string, unknown>,
    payload: Record<string, unknown>,
    { sessionId, model, timestamp }: CodexRecordContext,
  ): Generator<SessionEvent> {
    const role = typeof payload.role === 'string' ? MESSAGE_ROLES.get(payload.role) : undefined;

    if (!role) {
      recordKindSkippedRow(this.diagnostics, this.kinds, 'message', 'unknown_role');
      return;
    }

    const text = joinTextBlocks(payload.content, CODEX_TEXT_BLOCK_TYPES);

    if (text === undefined) {
      return;
    }

    const resolvedRole = role === 'user' && isInjectedContext(payload.content) ? 'system' : role;

    yield* this.atTimestamp('message', timestamp, (resolved) =>
      createKindEvent(this.diagnostics, this.kinds, 'message', () =>
        createMessageEvent({
          source: 'codex',
          sessionId,
          timestamp: resolved,
          role: resolvedRole,
          messageId: asTrimmedText(payload.id),
          model: resolvedRole === 'assistant' ? model : undefined,
          textLength: text.length,
          text: this.text ? text : undefined,
          raw: this.raw ? line : undefined,
        }),
      ),
    );
  }

  private startToolCall(
    line: Record<string, unknown>,
    payload: Record<string, unknown>,
    { sessionId, timestamp }: CodexRecordContext,
  ): void {
    const toolCallId = asTrimmedText(payload.call_id);
    const name = asTrimmedText(payload.name);

    if (!toolCallId || !name) {
      recordToolCallSkippedRow(
        this.diagnostics,
        this.kinds,
        toolCallId ? TOOL_CALL_REASONS.missingName : TOOL_CALL_REASONS.missingId,
      );
      return;
    }

    const call: PendingToolCall = { sessionId, timestamp, toolCallId, name, call: line };

    if (!this.pairing.start(toolCallId, call) || timestamp !== undefined) {
      return;
    }

    call.timestamp = this.carry.carry({
      kind: 'tool_call',
      release: (resolved) => {
        call.timestamp = resolved;
        // A call answered while it was held completes now.
        return call.result ? this.toolCallEvent(call, resolved) : undefined;
      },
    });
  }

  private *finishToolCall(
    line: Record<string, unknown>,
    payload: Record<string, unknown>,
    { timestamp }: CodexRecordContext,
  ): Generator<SessionEvent> {
    const toolCallId = asTrimmedText(payload.call_id);

    if (!toolCallId) {
      recordToolCallSkippedRow(this.diagnostics, this.kinds, TOOL_CALL_REASONS.resultMissingId);
      return;
    }

    const call = this.pairing.finish(toolCallId);

    if (!call) {
      return;
    }

    // Codex logs no error flag on a result: a result seen is a call that ran.
    call.result = { status: 'ok', completedAt: timestamp, record: line };

    if (call.timestamp !== undefined) {
      const event = this.toolCallEvent(call, call.timestamp);

      if (event) {
        yield event;
      }
    }
  }

  private *webSearch(
    line: Record<string, unknown>,
    payload: Record<string, unknown>,
    { sessionId, timestamp }: CodexRecordContext,
  ): Generator<SessionEvent> {
    const status = toWebSearchStatus(payload.status);

    // A web search is its own result: it completes at its record, with no call id.
    yield* this.atTimestamp('tool_call', timestamp, (resolved) =>
      createKindEvent(this.diagnostics, this.kinds, 'tool_call', () =>
        createToolCallEvent({
          source: 'codex',
          sessionId,
          timestamp: resolved,
          toolCallId: asTrimmedText(payload.id),
          name: WEB_SEARCH_TOOL_NAME,
          status,
          completedAt: status === 'unknown' ? undefined : timestamp,
          raw: this.raw ? { call: line } : undefined,
        }),
      ),
    );
  }

  private toolCallEvent(call: PendingToolCall, timestamp: string): SessionEvent | undefined {
    const { result } = call;

    return createKindEvent(this.diagnostics, this.kinds, 'tool_call', () =>
      createToolCallEvent({
        source: 'codex',
        sessionId: call.sessionId,
        timestamp,
        toolCallId: call.toolCallId,
        name: call.name,
        status: result?.status ?? 'unknown',
        completedAt: result?.completedAt,
        raw: this.raw
          ? result
            ? { call: call.call, result: result.record }
            : { call: call.call }
          : undefined,
      }),
    );
  }
}

/** The repo root a Codex payload states, as the usage state reads it. */
export function resolveCodexRepoRoot(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (!payload) {
    return undefined;
  }

  return (
    asTrimmedText(payload.cwd) ??
    asTrimmedText(payload.repo_root) ??
    asTrimmedText(payload.repoRoot) ??
    asTrimmedText(payload.project_root) ??
    asTrimmedText(payload.projectRoot)
  );
}
