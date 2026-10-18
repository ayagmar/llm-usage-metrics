import { asTrimmedText } from '../parsing-utils.js';
import { iterateRows, type SqliteRow, type SqliteRowStatement } from '../sqlite/iterate-rows.js';

export type OpenCodeSqliteRow = SqliteRow;

type OpenCodeSqliteDatabase = {
  prepare: (sql: string) => SqliteRowStatement;
};

type PartQueryColumns = {
  tableName: string;
  messageIdColumn: string;
  dataColumn: string;
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

/**
 * V1 sets a message's tokens to its last step's while adding up the cost of every step,
 * and writes one `step-finish` part per step with that step's tokens. This sums those
 * parts per message. The `LIKE` skips most parts before their JSON is parsed, and is
 * several times faster than `instr` on large part tables.
 */
function createStepTotalsJoin(parts: PartQueryColumns, messageIdColumn: string): string {
  const data = escapeIdentifier(parts.dataColumn);
  const sumOf = (jsonPath: string, alias: string): string =>
    `    SUM(json_extract(${data}, '${jsonPath}')) AS ${alias},`;

  return [
    'LEFT JOIN (',
    '  SELECT',
    `    ${escapeIdentifier(parts.messageIdColumn)} AS step_message_id,`,
    '    COUNT(*) AS step_count,',
    sumOf('$.tokens.input', 'step_input_tokens'),
    sumOf('$.tokens.output', 'step_output_tokens'),
    sumOf('$.tokens.reasoning', 'step_reasoning_tokens'),
    sumOf('$.tokens.cache.read', 'step_cache_read_tokens'),
    sumOf('$.tokens.cache.write', 'step_cache_write_tokens'),
    // A total only when every step has one, as a partial sum would not match the buckets.
    `    CASE WHEN COUNT(json_extract(${data}, '$.tokens.total')) = COUNT(*) THEN SUM(json_extract(${data}, '$.tokens.total')) END AS step_total_tokens`,
    `  FROM ${escapeIdentifier(parts.tableName)}`,
    `  WHERE ${data} LIKE '%"step-finish"%'`,
    `    AND CASE WHEN json_valid(${data}) = 1 THEN json_extract(${data}, '$.type') END = 'step-finish'`,
    `  GROUP BY ${escapeIdentifier(parts.messageIdColumn)}`,
    `) AS steps ON steps.step_message_id = ${escapeIdentifier(messageIdColumn)}`,
  ].join('\n');
}

function createPrimaryQuery(
  tableName: string,
  columns: MessageQueryColumns,
  parts: PartQueryColumns | undefined,
): string {
  const rowSessionId = columns.sessionIdColumn
    ? `${escapeIdentifier(columns.sessionIdColumn)} AS row_session_id`
    : 'NULL AS row_session_id';
  const stepColumns = parts
    ? [
        ',',
        '  steps.step_count, steps.step_input_tokens, steps.step_output_tokens,',
        '  steps.step_reasoning_tokens, steps.step_cache_read_tokens,',
        '  steps.step_cache_write_tokens, steps.step_total_tokens',
      ]
    : [];

  return [
    'SELECT',
    `  ${escapeIdentifier(columns.idColumn)} AS row_id,`,
    `  ${escapeIdentifier(columns.timestampColumn)} AS row_time,`,
    `  ${rowSessionId},`,
    `  ${escapeIdentifier(columns.dataColumn)} AS data_json${stepColumns.join('\n')}`,
    `FROM ${escapeIdentifier(tableName)}`,
    ...(parts ? [createStepTotalsJoin(parts, columns.idColumn)] : []),
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

function listTableNames(database: OpenCodeSqliteDatabase): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => asTrimmedText(row.name))
    .filter((value): value is string => Boolean(value));
}

function listColumnNames(database: OpenCodeSqliteDatabase, tableName: string): string[] {
  const escapedTableName = tableName.replaceAll("'", "''");
  return database
    .prepare(`PRAGMA table_info('${escapedTableName}')`)
    .all()
    .map((row) => asTrimmedText(row.name))
    .filter((value): value is string => Boolean(value));
}

function resolveMessageQueryColumns(
  database: OpenCodeSqliteDatabase,
  messageTableName: string,
): MessageQueryColumns {
  return resolveRequiredMessageColumns(listColumnNames(database, messageTableName));
}

/** The V1 `part` table, when it has the columns the step totals need. */
function resolvePartQueryColumns(
  database: OpenCodeSqliteDatabase,
  tableNames: readonly string[],
): PartQueryColumns | undefined {
  const tableName = resolveIdentifierCaseInsensitive(tableNames, ['part']);

  if (!tableName) {
    return undefined;
  }

  const partColumns = listColumnNames(database, tableName);
  const messageIdColumn = resolveIdentifierCaseInsensitive(partColumns, ['message_id']);
  const dataColumn = resolveIdentifierCaseInsensitive(partColumns, ['data']);

  return messageIdColumn && dataColumn ? { tableName, messageIdColumn, dataColumn } : undefined;
}

function queryV1MessageRows(
  database: OpenCodeSqliteDatabase,
  messageTableName: string,
  columns: MessageQueryColumns,
  parts: PartQueryColumns | undefined,
): IterableIterator<OpenCodeSqliteRow> {
  try {
    return iterateRows(database.prepare(createPrimaryQuery(messageTableName, columns, parts)));
  } catch (error) {
    if (!shouldFallbackToNonJsonExtractQuery(error)) {
      throw error;
    }

    return iterateRows(database.prepare(createFallbackQuery(messageTableName, columns)));
  }
}

/**
 * OpenCode V2 writes one `session_message` row per step, with the session's
 * directory on `session_v2`. Its migration copies V1 messages under the same ids and keeps
 * the V1 tables, so ids still in `message` are left to the V1 query.
 */
function createV2Query(tableNames: {
  sessionMessage: string;
  session: string;
  v1: { tableName: string; columns: MessageQueryColumns } | undefined;
}): string {
  const sessionMessage = escapeIdentifier(tableNames.sessionMessage);
  const v1 = tableNames.v1;
  const v1Filter = v1
    ? `  AND NOT EXISTS (SELECT 1 FROM ${escapeIdentifier(v1.tableName)} AS v1 WHERE v1.${escapeIdentifier(v1.columns.idColumn)} = m."id")`
    : undefined;

  return [
    'SELECT',
    '  m."id" AS row_id,',
    '  m."time_created" AS row_time,',
    '  m."session_id" AS row_session_id,',
    '  m."type" AS row_type,',
    '  s."directory" AS row_directory,',
    '  m."data" AS data_json',
    `FROM ${sessionMessage} AS m`,
    `LEFT JOIN ${escapeIdentifier(tableNames.session)} AS s ON s."id" = m."session_id"`,
    'WHERE m."type" = \'assistant\'',
    ...(v1Filter ? [v1Filter] : []),
    'ORDER BY m."time_created" ASC, m."id" ASC',
  ].join('\n');
}

function* chainRows(
  first: IterableIterator<OpenCodeSqliteRow>,
  second: IterableIterator<OpenCodeSqliteRow>,
): Generator<OpenCodeSqliteRow> {
  try {
    yield* first;
    yield* second;
  } finally {
    second.return?.();
  }
}

/**
 * The assistant message rows of a V1 database (`message`), a V2 one (`session_message`
 * with `session_v2`), or both after OpenCode's in-place migration: V1 rows first. Each
 * query's first row is already pulled (see `iterateRows`). V2 rows carry `row_type`.
 */
export function queryOpenCodeMessageRows(
  database: OpenCodeSqliteDatabase,
): IterableIterator<OpenCodeSqliteRow> {
  const tableNames = listTableNames(database);
  const v1TableName = resolveIdentifierCaseInsensitive(tableNames, ['message']);
  const v1 = v1TableName
    ? { tableName: v1TableName, columns: resolveMessageQueryColumns(database, v1TableName) }
    : undefined;
  const sessionMessage = resolveIdentifierCaseInsensitive(tableNames, ['session_message']);
  const session = resolveIdentifierCaseInsensitive(tableNames, ['session_v2']);
  const v2Rows =
    sessionMessage && session
      ? iterateRows(database.prepare(createV2Query({ sessionMessage, session, v1 })))
      : undefined;

  if (!v1) {
    if (!v2Rows && sessionMessage && resolveIdentifierCaseInsensitive(tableNames, ['session'])) {
      throw new Error(
        'This is the pre-release OpenCode V2 database (opencode-next.db): OpenCode 2 imports it into opencode.db on start. Read opencode.db instead.',
      );
    }

    if (!v2Rows) {
      throw new Error(
        'OpenCode schema drift: no "message" table (V1) or "session_message" and "session_v2" tables (V2) found. Inspect schema with `opencode db` commands.',
      );
    }

    return v2Rows;
  }

  const v1Rows = queryV1MessageRows(
    database,
    v1.tableName,
    v1.columns,
    resolvePartQueryColumns(database, tableNames),
  );
  return v2Rows ? chainRows(v1Rows, v2Rows) : v1Rows;
}
