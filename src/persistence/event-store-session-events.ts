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
  selectFileId: EventStoreStatement;
  insertFile: EventStoreStatement;
  deleteFile: EventStoreStatement;
  deleteToolCalls: EventStoreStatement;
  deleteMessages: EventStoreStatement;
  insertToolCall: EventStoreStatement;
  insertMessage: EventStoreStatement;
};

export function prepareSessionEventStatements(
  database: EventStoreDatabase,
): SessionEventStatements {
  return {
    selectFileId: database.prepare(
      'SELECT id FROM session_event_files WHERE source = ? AND file_path = ?',
    ),
    insertFile: database.prepare(
      'INSERT INTO session_event_files (source, file_path) VALUES (?, ?)',
    ),
    deleteFile: database.prepare('DELETE FROM session_event_files WHERE id = ?'),
    deleteToolCalls: database.prepare('DELETE FROM tool_calls WHERE file_id = ?'),
    deleteMessages: database.prepare('DELETE FROM messages WHERE file_id = ?'),
    insertToolCall: database.prepare(
      [
        'INSERT INTO tool_calls (',
        '  file_id, event_index, session_id, timestamp, tool_call_id, name, status,',
        '  completed_at, duration_ms, message_id',
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ].join('\n'),
    ),
    insertMessage: database.prepare(
      [
        'INSERT INTO messages (',
        '  file_id, event_index, session_id, timestamp, role, message_id, model, text_length',
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ].join('\n'),
    ),
  };
}

function selectFileId(
  statements: SessionEventStatements,
  source: string,
  filePath: string,
): number | undefined {
  return toNonNegativeInteger(statements.selectFileId.get(source, filePath)?.id);
}

/** Deletes the file's stored tool calls and messages; call inside a write transaction. */
export function deleteFileSessionEvents(
  statements: SessionEventStatements,
  source: string,
  filePath: string,
): void {
  const fileId = selectFileId(statements, source, filePath);

  if (fileId === undefined) {
    return;
  }

  statements.deleteToolCalls.run(fileId);
  statements.deleteMessages.run(fileId);
  statements.deleteFile.run(fileId);
}

/** Replaces the file's stored tool calls and messages; call inside a write transaction. */
export function writeFileSessionEvents(
  statements: SessionEventStatements,
  source: string,
  filePath: string,
  events: readonly StoredSessionEvent[],
): void {
  deleteFileSessionEvents(statements, source, filePath);

  if (events.length === 0) {
    return;
  }

  statements.insertFile.run(source, filePath);
  const fileId = selectFileId(statements, source, filePath);

  events.forEach((event, eventIndex) => {
    if (event.kind === 'tool_call') {
      statements.insertToolCall.run(
        fileId,
        eventIndex,
        event.sessionId,
        Date.parse(event.timestamp),
        event.toolCallId ?? null,
        event.name,
        event.status,
        event.completedAt === undefined ? null : Date.parse(event.completedAt),
        event.durationMs ?? null,
        event.messageId ?? null,
      );
      return;
    }

    statements.insertMessage.run(
      fileId,
      eventIndex,
      event.sessionId,
      Date.parse(event.timestamp),
      event.role,
      event.messageId ?? null,
      event.model ?? null,
      event.textLength,
    );
  });
}

/**
 * SQL for the tool call and message count of the `session_event_files` row aliased `alias`;
 * the one definition both the delete counts and the history counts use.
 */
export function sessionEventCountSql(alias: string): string {
  return [
    `(SELECT COUNT(*) FROM tool_calls WHERE file_id = ${alias}.id)`,
    `+ (SELECT COUNT(*) FROM messages WHERE file_id = ${alias}.id)`,
  ].join(' ');
}

/** How many tool calls and messages the store holds for the file. */
export function countFileSessionEvents(
  database: EventStoreDatabase,
  source: string,
  filePath: string,
): number {
  const row = database
    .prepare(
      [
        `SELECT ${sessionEventCountSql('file')} AS count`,
        'FROM session_event_files AS file',
        'WHERE file.source = ? AND file.file_path = ?',
      ].join('\n'),
    )
    .get(source, filePath);
  return toNonNegativeInteger(row?.count) ?? 0;
}

const SELECT_TOOL_CALLS = [
  "SELECT event_index, 'tool_call' AS kind, session_id, timestamp, tool_call_id, name, status,",
  '  completed_at, duration_ms, message_id, NULL AS role, NULL AS model, NULL AS text_length',
  'FROM tool_calls',
  'WHERE file_id = (SELECT id FROM session_event_files WHERE source = ? AND file_path = ?)',
].join('\n');
const SELECT_MESSAGES = [
  "SELECT event_index, 'message' AS kind, session_id, timestamp, NULL AS tool_call_id,",
  '  NULL AS name, NULL AS status, NULL AS completed_at, NULL AS duration_ms, message_id, role,',
  '  model, text_length',
  'FROM messages',
  'WHERE file_id = (SELECT id FROM session_event_files WHERE source = ? AND file_path = ?)',
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

/** One file's stored events, through a statement from `prepareSelectFileSessionEvents`. */
export function selectFileSessionEvents(
  select: { statement: EventStoreStatement; parameterCount: number },
  source: string,
  filePath: string,
): StoredSessionEvent[] {
  const parameters = Array.from({ length: select.parameterCount }, () => [source, filePath]).flat();

  return select.statement
    .all(...parameters)
    .map((row) => decodeStoredSessionEvent(source, row))
    .filter((event) => event !== undefined);
}

/** The stored row as the event it was; undefined for a row the constructors reject. */
export function decodeStoredSessionEvent(
  source: string,
  row: Record<string, unknown>,
): StoredSessionEvent | undefined {
  const base = {
    source,
    sessionId: toText(row.session_id) ?? '',
    timestamp: decodeTimestamp(row.timestamp) ?? '',
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
        completedAt: decodeTimestamp(row.completed_at),
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

// The largest epoch milliseconds a Date holds.
const MAX_DATE_MILLISECONDS = 8.64e15;

// The ISO string a stored timestamp was written from; undefined for any other value, which
// the constructors then reject.
function decodeTimestamp(value: unknown): string | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    Math.abs(value) <= MAX_DATE_MILLISECONDS
    ? new Date(value).toISOString()
    : undefined;
}
