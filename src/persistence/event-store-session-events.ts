import {
  createMessageEvent,
  createToolCallEvent,
  type MessageEvent,
  type ToolCallEvent,
} from '@ayagmar/agent-sessions';

import {
  toNonNegativeInteger,
  toText,
  type EventStoreDatabase,
  type EventStoreStatement,
} from './event-store-database.js';

/** The non-usage events the store keeps: typed fields only, never text or raw. */
export type StoredSessionEvent = ToolCallEvent | MessageEvent;

export type StoredSessionEventKind = StoredSessionEvent['kind'];

export type SessionEventStatements = {
  deleteToolCalls: EventStoreStatement;
  deleteMessages: EventStoreStatement;
  insertToolCall: EventStoreStatement;
  insertMessage: EventStoreStatement;
};

export function prepareSessionEventStatements(
  database: EventStoreDatabase,
): SessionEventStatements {
  return {
    deleteToolCalls: database.prepare('DELETE FROM tool_calls WHERE source = ? AND file_path = ?'),
    deleteMessages: database.prepare('DELETE FROM messages WHERE source = ? AND file_path = ?'),
    insertToolCall: database.prepare(
      [
        'INSERT INTO tool_calls (',
        '  source, file_path, event_index, session_id, timestamp, tool_call_id, name, status,',
        '  completed_at, duration_ms, message_id',
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ].join('\n'),
    ),
    insertMessage: database.prepare(
      [
        'INSERT INTO messages (',
        '  source, file_path, event_index, session_id, timestamp, role, message_id, model,',
        '  text_length',
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ].join('\n'),
    ),
  };
}

/** Replaces the file's stored tool calls and messages; call inside a write transaction. */
export function writeFileSessionEvents(
  statements: SessionEventStatements,
  source: string,
  filePath: string,
  events: readonly StoredSessionEvent[],
): void {
  statements.deleteToolCalls.run(source, filePath);
  statements.deleteMessages.run(source, filePath);

  events.forEach((event, eventIndex) => {
    if (event.kind === 'tool_call') {
      statements.insertToolCall.run(
        source,
        filePath,
        eventIndex,
        event.sessionId,
        event.timestamp,
        event.toolCallId ?? null,
        event.name,
        event.status,
        event.completedAt ?? null,
        event.durationMs ?? null,
        event.messageId ?? null,
      );
      return;
    }

    statements.insertMessage.run(
      source,
      filePath,
      eventIndex,
      event.sessionId,
      event.timestamp,
      event.role,
      event.messageId ?? null,
      event.model ?? null,
      event.textLength,
    );
  });
}

const SELECT_TOOL_CALLS = [
  "SELECT event_index, 'tool_call' AS kind, session_id, timestamp, tool_call_id, name, status,",
  '  completed_at, duration_ms, message_id, NULL AS role, NULL AS model, NULL AS text_length',
  'FROM tool_calls WHERE source = ? AND file_path = ?',
].join('\n');
const SELECT_MESSAGES = [
  "SELECT event_index, 'message' AS kind, session_id, timestamp, NULL AS tool_call_id,",
  '  NULL AS name, NULL AS status, NULL AS completed_at, NULL AS duration_ms, message_id, role,',
  '  model, text_length',
  'FROM messages WHERE source = ? AND file_path = ?',
].join('\n');

/** A statement that reads one file's events of `kinds` in the order they were stored. */
export function prepareSelectFileSessionEvents(
  database: EventStoreDatabase,
  kinds: ReadonlySet<StoredSessionEventKind>,
): { statement: EventStoreStatement; parameterCount: number } | undefined {
  const selects = [
    ...(kinds.has('tool_call') ? [SELECT_TOOL_CALLS] : []),
    ...(kinds.has('message') ? [SELECT_MESSAGES] : []),
  ];

  if (selects.length === 0) {
    return undefined;
  }

  return {
    statement: database.prepare(`${selects.join('\nUNION ALL\n')}\nORDER BY event_index ASC`),
    parameterCount: selects.length,
  };
}

/** The stored row as the event it was; undefined for a row the constructors reject. */
export function decodeStoredSessionEvent(
  source: string,
  row: Record<string, unknown>,
): StoredSessionEvent | undefined {
  const base = {
    source,
    sessionId: toText(row.session_id) ?? '',
    timestamp: toText(row.timestamp) ?? '',
  };

  try {
    if (row.kind === 'tool_call') {
      const durationMs = toNonNegativeInteger(row.duration_ms);
      const status = toText(row.status) ?? '';

      return createToolCallEvent({
        ...base,
        toolCallId: toText(row.tool_call_id),
        name: toText(row.name) ?? '',
        // The constructor rejects a status outside ToolCallStatus.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        status: status as ToolCallEvent['status'],
        completedAt: toText(row.completed_at),
        durationMs,
        messageId: toText(row.message_id),
      });
    }

    const role = toText(row.role) ?? '';

    return createMessageEvent({
      ...base,
      // The constructor rejects a role outside MessageEvent['role'].
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      role: role as MessageEvent['role'],
      messageId: toText(row.message_id),
      model: toText(row.model),
      textLength: toNonNegativeInteger(row.text_length) ?? 0,
    });
  } catch {
    return undefined;
  }
}
