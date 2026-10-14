import { asTrimmedText } from '../parsing-utils.js';

export type OpenCodeSqliteRow = Record<string, unknown>;

type OpenCodeSqliteDatabase = {
  prepare: (sql: string) => {
    all: (...anonymousParameters: unknown[]) => OpenCodeSqliteRow[];
    iterate?: (...anonymousParameters: unknown[]) => IterableIterator<OpenCodeSqliteRow>;
  };
};

type MessageQueryColumns = {
  idColumn: string;
  timestampColumn: string;
  dataColumn: string;
  sessionIdColumn: string | undefined;
};

function shouldFallbackToNonJsonExtractQuery(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such function:\s*json_(?:extract|valid)|malformed JSON/iu.test(message);
}

function escapeIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function resolveIdentifierCaseInsensitive(
  identifiers: readonly string[],
  candidates: readonly string[],
): string | undefined {
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.toLowerCase();
    const matchedIdentifier = identifiers.find(
      (identifier) => identifier.toLowerCase() === normalizedCandidate,
    );

    if (matchedIdentifier) {
      return matchedIdentifier;
    }
  }

  return undefined;
}

function resolveRequiredMessageColumns(messageColumns: readonly string[]): MessageQueryColumns {
  const dataColumn = resolveIdentifierCaseInsensitive(messageColumns, ['data']);

  if (!dataColumn) {
    throw new Error(
      'OpenCode schema drift: "message.data" column not found. Inspect schema with `opencode db` commands.',
    );
  }

  const idColumn = resolveIdentifierCaseInsensitive(messageColumns, ['id', 'message_id']);
  const timestampColumn = resolveIdentifierCaseInsensitive(messageColumns, [
    'time_created',
    'created_at',
    'timestamp',
  ]);
  const sessionIdColumn = resolveIdentifierCaseInsensitive(messageColumns, [
    'session_id',
    'sessionid',
  ]);

  if (!idColumn || !timestampColumn) {
    throw new Error(
      'OpenCode schema drift: required message id/timestamp columns are unavailable. Inspect schema with `opencode db` commands.',
    );
  }

  return {
    idColumn,
    timestampColumn,
    dataColumn,
    sessionIdColumn,
  };
}

function createPrimaryQuery(tableName: string, columns: MessageQueryColumns): string {
  const rowSessionId = columns.sessionIdColumn
    ? `${escapeIdentifier(columns.sessionIdColumn)} AS row_session_id`
    : 'NULL AS row_session_id';

  return [
    'SELECT',
    `  ${escapeIdentifier(columns.idColumn)} AS row_id,`,
    `  ${escapeIdentifier(columns.timestampColumn)} AS row_time,`,
    `  ${rowSessionId},`,
    `  ${escapeIdentifier(columns.dataColumn)} AS data_json`,
    `FROM ${escapeIdentifier(tableName)}`,
    [
      'WHERE CASE',
      `  WHEN json_valid(${escapeIdentifier(columns.dataColumn)}) = 1`,
      `    THEN lower(trim(coalesce(json_extract(${escapeIdentifier(columns.dataColumn)}, '$.role'), json_extract(${escapeIdentifier(columns.dataColumn)}, '$.type'))))`,
      "  ELSE 'assistant'",
      "END = 'assistant'",
    ].join('\n'),
    `ORDER BY ${escapeIdentifier(columns.timestampColumn)} ASC, ${escapeIdentifier(columns.idColumn)} ASC`,
  ].join('\n');
}

function createFallbackQuery(tableName: string, columns: MessageQueryColumns): string {
  const rowSessionId = columns.sessionIdColumn
    ? `${escapeIdentifier(columns.sessionIdColumn)} AS row_session_id`
    : 'NULL AS row_session_id';

  return [
    'SELECT',
    `  ${escapeIdentifier(columns.idColumn)} AS row_id,`,
    `  ${escapeIdentifier(columns.timestampColumn)} AS row_time,`,
    `  ${rowSessionId},`,
    `  ${escapeIdentifier(columns.dataColumn)} AS data_json`,
    `FROM ${escapeIdentifier(tableName)}`,
    `ORDER BY ${escapeIdentifier(columns.timestampColumn)} ASC, ${escapeIdentifier(columns.idColumn)} ASC`,
  ].join('\n');
}

function resolveMessageTableName(database: OpenCodeSqliteDatabase): string {
  const tablesResult = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => asTrimmedText(row.name))
    .filter((value): value is string => Boolean(value));
  const messageTableName = resolveIdentifierCaseInsensitive(tablesResult, ['message']);

  if (!messageTableName) {
    throw new Error(
      'OpenCode schema drift: required "message" table not found. Inspect schema with `opencode db` commands.',
    );
  }

  return messageTableName;
}

function resolveMessageQueryColumns(
  database: OpenCodeSqliteDatabase,
  messageTableName: string,
): MessageQueryColumns {
  const escapedMessageTableName = messageTableName.replaceAll("'", "''");
  const messageColumns = database
    .prepare(`PRAGMA table_info('${escapedMessageTableName}')`)
    .all()
    .map((row) => asTrimmedText(row.name))
    .filter((value): value is string => Boolean(value));

  return resolveRequiredMessageColumns(messageColumns);
}

function executeQueryRows(
  database: OpenCodeSqliteDatabase,
  query: string,
): Iterable<OpenCodeSqliteRow> {
  const statement = database.prepare(query);

  if (statement.iterate) {
    const iterator = statement.iterate();
    const firstResult = iterator.next();

    return (function* iterRows(): IterableIterator<OpenCodeSqliteRow> {
      if (!firstResult.done) {
        yield firstResult.value;
      }

      yield* iterator;
    })();
  }

  return statement.all();
}

export function queryOpenCodeMessageRows(
  database: OpenCodeSqliteDatabase,
): Iterable<OpenCodeSqliteRow> {
  const messageTableName = resolveMessageTableName(database);
  const columns = resolveMessageQueryColumns(database, messageTableName);
  const primaryQuery = createPrimaryQuery(messageTableName, columns);

  try {
    return executeQueryRows(database, primaryQuery);
  } catch (error) {
    if (!shouldFallbackToNonJsonExtractQuery(error)) {
      throw error;
    }

    return executeQueryRows(database, createFallbackQuery(messageTableName, columns));
  }
}
