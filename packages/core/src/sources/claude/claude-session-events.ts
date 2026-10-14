import {
  createMessageEvent,
  createSessionMetaEvent,
  createToolCallEvent,
  type EventKind,
  type MessageEvent,
  type SessionEvent,
  type SessionMetaFields,
} from '../../domain/session-event.js';
import { asRecord } from '../../utils/as-record.js';
import { asTrimmedText, normalizeTimestampCandidate } from '../parsing-utils.js';
import { getClaudeMessageKey } from './claude-fork-transcript.js';
import {
  createKindEvent,
  joinTextBlocks,
  recordKindSkippedRow,
  recordToolCallSkippedRow,
  SessionMetaTracker,
  TimestampCarry,
  TOOL_CALL_REASONS,
  ToolCallPairing,
  type ToolCallReason,
} from '../session-event-helpers.js';
import type { SourceReadDiagnostics } from '../source-adapter.js';

type NonUsageKind = Exclude<EventKind, 'usage'>;

// The rows the non-usage kinds come from; every other row type is ignored.
const SESSION_ROW_TYPES: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'ai-title',
  'custom-title',
]);
const SESSION_ROW_BYTES = [...SESSION_ROW_TYPES].map((type) => Buffer.from(`"${type}"`));
const TEXT_BLOCK_TYPES: ReadonlySet<string> = new Set(['text']);

/** The union prefilter of a read that wants any non-usage kind; it accepts every usage line. */
export function shouldParseClaudeSessionLineBytes(lineBytes: Buffer): boolean {
  return SESSION_ROW_BYTES.some((typeBytes) => lineBytes.includes(typeBytes));
}

export type ClaudeSessionEventsOptions = {
  fallbackSessionId: string;
  kinds: ReadonlySet<EventKind>;
  text: boolean;
  raw: boolean;
  diagnostics: SourceReadDiagnostics;
  /**
   * A fork's parent transcript: its row uuids, and the message keys of its assistant rows.
   * A row the fork replayed from it is skipped. Forks also re-log the parent's last call
   * under a new uuid, so an assistant row is replayed when its message key is the parent's.
   */
  replayedRowUuids: ReadonlySet<string>;
  replayedMessageKeys: ReadonlySet<string>;
};

type ToolCall = {
  sessionId: string;
  timestamp: string;
  toolCallId: string;
  name: string;
  messageId?: string;
  row?: Record<string, unknown>;
};

/** What one row contributes once its timestamp is known, possibly an event. */
type RowAction = {
  kind: NonUsageKind;
  run: (timestamp: string) => SessionEvent | undefined;
};

type ContentBlock = Record<string, unknown>;

function contentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: ContentBlock[] = [];

  for (const block of content as unknown[]) {
    const record = asRecord(block);

    if (record) {
      blocks.push(record);
    }
  }

  return blocks;
}

/**
 * Message, tool_call and session_meta events of a Claude transcript, row by row. Events
 * complete in row order; tool calls complete at their result, or at the end of the file.
 */
export class ClaudeSessionEvents {
  private readonly carry = new TimestampCarry<RowAction>();
  private readonly pairing: ToolCallPairing<ToolCall>;
  private readonly meta: SessionMetaTracker;
  private readonly messageRowUuids = new Set<string>();
  // Calls in rows replayed from a fork's parent: a result for one is not an orphan.
  private readonly replayedCallIds = new Set<string>();

  public constructor(private readonly options: ClaudeSessionEventsOptions) {
    this.pairing = new ToolCallPairing(options.diagnostics, options.kinds);
    this.meta = new SessionMetaTracker(options.text);
  }

  public *add(line: Record<string, unknown>): Generator<SessionEvent> {
    const type = asTrimmedText(line.type);

    if (!type || !SESSION_ROW_TYPES.has(type)) {
      return;
    }

    const uuid = asTrimmedText(line.uuid);

    if ((uuid && this.options.replayedRowUuids.has(uuid)) || this.isReplayedCall(type, line)) {
      this.noteReplayedCalls(type, line);
      return;
    }

    const actions = this.rowActions(type, line, uuid);
    const timestamp = normalizeTimestampCandidate(line.timestamp);

    if (timestamp) {
      for (const held of this.carry.advance(timestamp)) {
        yield* this.run(held, timestamp);
      }
    }

    for (const action of actions) {
      const actionTimestamp = timestamp ?? this.carry.carry(action);

      if (actionTimestamp) {
        yield* this.run(action, actionTimestamp);
      }
    }
  }

  private isReplayedCall(type: string, line: Record<string, unknown>): boolean {
    const message = type === 'assistant' ? asRecord(line.message) : undefined;
    const messageKey = message ? getClaudeMessageKey(line, message) : undefined;
    return messageKey !== undefined && this.options.replayedMessageKeys.has(messageKey);
  }

  private noteReplayedCalls(type: string, line: Record<string, unknown>): void {
    if (type !== 'assistant') {
      return;
    }

    for (const block of contentBlocks(asRecord(line.message)?.content)) {
      const toolCallId = block.type === 'tool_use' ? asTrimmedText(block.id) : undefined;

      if (toolCallId) {
        this.replayedCallIds.add(toolCallId);
      }
    }
  }

  /** At end of file: the calls never answered, as `unknown`. */
  public *finish(): Generator<SessionEvent> {
    for (const call of this.pairing.takeUnanswered()) {
      const event = this.createToolCall(call, 'unknown');

      if (event) {
        yield event;
      }
    }

    for (const held of this.carry.takeUnreleased()) {
      recordKindSkippedRow(
        this.options.diagnostics,
        this.options.kinds,
        held.kind,
        'invalid_timestamp',
      );
    }
  }

  private *run(action: RowAction, timestamp: string): Generator<SessionEvent> {
    const event = action.run(timestamp);

    if (event) {
      yield event;
    }
  }

  private rowActions(
    type: string,
    line: Record<string, unknown>,
    uuid: string | undefined,
  ): RowAction[] {
    const sessionId = asTrimmedText(line.sessionId) ?? this.options.fallbackSessionId;
    const actions: RowAction[] = [];
    const metaAction = this.metaAction(type, line, sessionId);

    if (metaAction) {
      actions.push(metaAction);
    }

    if (type === 'user') {
      actions.push(...this.userActions(line, sessionId, uuid));
    } else if (type === 'assistant') {
      actions.push(...this.assistantActions(line, sessionId, uuid));
    }

    return actions;
  }

  private metaAction(
    type: string,
    line: Record<string, unknown>,
    sessionId: string,
  ): RowAction | undefined {
    const aiTitle = type === 'ai-title';
    const stated: SessionMetaFields = {
      cwd: asText(line.cwd),
      gitBranch: asText(line.gitBranch),
      agentVersion: asText(line.version),
      title: aiTitle
        ? asText(line.aiTitle)
        : type === 'custom-title'
          ? asText(line.customTitle)
          : undefined,
    };

    if (
      [stated.cwd, stated.gitBranch, stated.agentVersion, stated.title].every(
        (value) => value === undefined,
      )
    ) {
      return undefined;
    }

    return {
      kind: 'session_meta',
      run: (timestamp) => {
        const changes = this.meta.changes(stated, { aiTitle });

        return changes
          ? this.createKind('session_meta', () =>
              createSessionMetaEvent({
                source: 'claude',
                sessionId,
                timestamp,
                ...changes,
                raw: this.options.raw ? line : undefined,
              }),
            )
          : undefined;
      },
    };
  }

  private userActions(
    line: Record<string, unknown>,
    sessionId: string,
    uuid: string | undefined,
  ): RowAction[] {
    const message = asRecord(line.message);

    if (
      !message ||
      asTrimmedText(message.role) !== 'user' ||
      (typeof message.content !== 'string' && !Array.isArray(message.content))
    ) {
      this.recordSkipped('message', 'invalid_user_message');
      return [];
    }

    const actions: RowAction[] = [];

    if (line.isMeta !== true) {
      const role = line.isCompactSummary === true ? 'system' : 'user';
      const messageAction = this.messageAction(line, message, { sessionId, uuid, role });

      if (messageAction) {
        actions.push(messageAction);
      }
    }

    const results = contentBlocks(message.content).filter((block) => block.type === 'tool_result');
    // A row carries one toolUseResult, so its duration is the result's only when it is alone.
    const durationMs = results.length === 1 ? asRecord(line.toolUseResult)?.durationMs : undefined;

    for (const result of results) {
      const toolCallId = asTrimmedText(result.tool_use_id);

      if (!toolCallId) {
        this.recordToolCallSkipped(TOOL_CALL_REASONS.resultMissingId);
        continue;
      }

      if (this.replayedCallIds.has(toolCallId)) {
        continue;
      }

      actions.push({
        kind: 'tool_call',
        run: (timestamp) => {
          const call = this.pairing.finish(toolCallId);

          return call
            ? this.createToolCall(call, result.is_error === true ? 'error' : 'ok', {
                completedAt: timestamp,
                durationMs: typeof durationMs === 'number' ? durationMs : undefined,
                resultRow: line,
              })
            : undefined;
        },
      });
    }

    return actions;
  }

  private assistantActions(
    line: Record<string, unknown>,
    sessionId: string,
    uuid: string | undefined,
  ): RowAction[] {
    const message = asRecord(line.message);

    if (!message || asTrimmedText(message.role) !== 'assistant') {
      this.recordSkipped('message', 'invalid_assistant_message');
      this.recordSkipped('tool_call', 'invalid_assistant_message');
      return [];
    }

    const actions: RowAction[] = [];
    const messageId = asTrimmedText(message.id);

    if (asTrimmedText(message.model) !== '<synthetic>') {
      const messageAction = this.messageAction(line, message, {
        sessionId,
        uuid,
        role: 'assistant',
        messageId,
        model: asText(message.model),
      });

      if (messageAction) {
        actions.push(messageAction);
      }
    }

    for (const block of contentBlocks(message.content)) {
      if (block.type !== 'tool_use') {
        continue;
      }

      const toolCallId = asTrimmedText(block.id);
      const name = asTrimmedText(block.name);

      if (!toolCallId || !name) {
        this.recordToolCallSkipped(
          toolCallId ? TOOL_CALL_REASONS.missingName : TOOL_CALL_REASONS.missingId,
        );
        continue;
      }

      actions.push({
        kind: 'tool_call',
        run: (timestamp) => {
          this.pairing.start(toolCallId, {
            sessionId,
            timestamp,
            toolCallId,
            name,
            messageId,
            row: this.options.raw ? line : undefined,
          });
          return undefined;
        },
      });
    }

    return actions;
  }

  /** One message per row uuid that has text; the first row with a uuid wins. */
  private messageAction(
    line: Record<string, unknown>,
    message: Record<string, unknown>,
    fields: {
      sessionId: string;
      uuid: string | undefined;
      role: MessageEvent['role'];
      messageId?: string;
      model?: string;
    },
  ): RowAction | undefined {
    const text = joinTextBlocks(message.content, TEXT_BLOCK_TYPES);

    if (text === undefined) {
      return undefined;
    }

    if (fields.uuid) {
      if (this.messageRowUuids.has(fields.uuid)) {
        return undefined;
      }

      this.messageRowUuids.add(fields.uuid);
    }

    return {
      kind: 'message',
      run: (timestamp) =>
        this.createKind('message', () =>
          createMessageEvent({
            source: 'claude',
            sessionId: fields.sessionId,
            timestamp,
            role: fields.role,
            messageId: fields.messageId,
            model: fields.model,
            textLength: text.length,
            text: this.options.text ? text : undefined,
            raw: this.options.raw ? line : undefined,
          }),
        ),
    };
  }

  private createToolCall(
    call: ToolCall,
    status: 'ok' | 'error' | 'unknown',
    result: {
      completedAt?: string;
      durationMs?: number;
      resultRow?: Record<string, unknown>;
    } = {},
  ): SessionEvent | undefined {
    return this.createKind('tool_call', () =>
      createToolCallEvent({
        source: 'claude',
        sessionId: call.sessionId,
        timestamp: call.timestamp,
        toolCallId: call.toolCallId,
        name: call.name,
        status,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
        messageId: call.messageId,
        raw: this.options.raw
          ? result.resultRow
            ? { call: call.row, result: result.resultRow }
            : { call: call.row }
          : undefined,
      }),
    );
  }

  private createKind(kind: NonUsageKind, create: () => SessionEvent): SessionEvent | undefined {
    return createKindEvent(this.options.diagnostics, this.options.kinds, kind, create);
  }

  private recordSkipped(kind: NonUsageKind, reason: string): void {
    recordKindSkippedRow(this.options.diagnostics, this.options.kinds, kind, reason);
  }

  private recordToolCallSkipped(reason: ToolCallReason): void {
    recordToolCallSkippedRow(this.options.diagnostics, this.options.kinds, reason);
  }
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
