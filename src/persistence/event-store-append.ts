import type { ReadCursor, ReplacedEventCounts } from '@ayagmar/agent-sessions';

import {
  toNonNegativeInteger,
  type EventStoreDatabase,
  type EventStoreStatement,
} from './event-store-database.js';

// Incremental ingest. A file of an incremental source is stored with the cursor its read
// ended at, so a later run that finds the file grown reads only the appended lines and
// appends their rows. A cursor holds only for the stored version it was written with:
// its fingerprint must equal the file's stored fingerprint, so a write by a build that
// does not know this table leaves the cursor unused.

/** Added without a schema version bump: older builds ignore it (see above). */
export function createReadCursorsSql(): string {
  return `
CREATE TABLE IF NOT EXISTS file_read_cursors (
  file_id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  cursor TEXT NOT NULL
);`;
}

/** The rows a resumed read keeps: the stored version it continues and what it replaces. */
export type EventStoreAppend = {
  /** The stored fingerprint the cursor belonged to; another one skips the write. */
  expectedFingerprint: string;
  replaced: ReplacedEventCounts;
};

export type ReadCursorStatements = {
  select: EventStoreStatement;
  upsert: EventStoreStatement;
  delete: EventStoreStatement;
};

export function prepareReadCursorStatements(database: EventStoreDatabase): ReadCursorStatements {
  return {
    select: database.prepare(
      [
        'SELECT cursor.cursor AS cursor',
        'FROM file_read_cursors AS cursor',
        'JOIN files AS file ON file.id = cursor.file_id',
        'WHERE file.source = ? AND file.file_path = ? AND cursor.fingerprint = file.fingerprint',
      ].join('\n'),
    ),
    upsert: database.prepare(
      [
        'INSERT INTO file_read_cursors (file_id, fingerprint, cursor) VALUES (?, ?, ?)',
        'ON CONFLICT(file_id) DO UPDATE SET',
        '  fingerprint = excluded.fingerprint,',
        '  cursor = excluded.cursor',
      ].join('\n'),
    ),
    delete: database.prepare('DELETE FROM file_read_cursors WHERE file_id = ?'),
  };
}

/** Stores the file's cursor with its fingerprint, or drops it; inside a write transaction. */
export function writeFileReadCursor(
  statements: ReadCursorStatements,
  fileId: number,
  fingerprint: string,
  cursor: ReadCursor | undefined,
): void {
  if (cursor) {
    statements.upsert.run(fileId, fingerprint, JSON.stringify(cursor));
  } else {
    statements.delete.run(fileId);
  }
}

export type AppendStatements = {
  selectFile: EventStoreStatement;
  deleteLastEvents: EventStoreStatement;
  deleteLastToolCalls: EventStoreStatement;
  deleteLastMessages: EventStoreStatement;
  nextEventIndex: EventStoreStatement;
  nextSessionEventIndex: EventStoreStatement;
};

function deleteLastRowsSql(table: string): string {
  return [
    `DELETE FROM ${table} WHERE file_id = ? AND event_index IN (`,
    `  SELECT event_index FROM ${table} WHERE file_id = ? ORDER BY event_index DESC LIMIT ?`,
    ')',
  ].join('\n');
}

export function prepareAppendStatements(database: EventStoreDatabase): AppendStatements {
  return {
    selectFile: database.prepare(
      'SELECT id, fingerprint FROM files WHERE source = ? AND file_path = ?',
    ),
    deleteLastEvents: database.prepare(deleteLastRowsSql('events')),
    deleteLastToolCalls: database.prepare(deleteLastRowsSql('tool_calls')),
    deleteLastMessages: database.prepare(deleteLastRowsSql('messages')),
    nextEventIndex: database.prepare(
      'SELECT COALESCE(MAX(event_index) + 1, 0) AS next FROM events WHERE file_id = ?',
    ),
    // Tool calls and messages share one index, their order in the file's reads.
    nextSessionEventIndex: database.prepare(
      [
        'SELECT MAX(',
        '  (SELECT COALESCE(MAX(event_index) + 1, 0) FROM tool_calls WHERE file_id = ?),',
        '  (SELECT COALESCE(MAX(event_index) + 1, 0) FROM messages WHERE file_id = ?)',
        ') AS next',
      ].join('\n'),
    ),
  };
}

/**
 * The id of the file a resumed read continues, with the rows it replaces deleted, and
 * where its rows start; undefined, with nothing deleted, when another run stored another
 * version of the file since. Call inside a write transaction.
 */
export function prepareFileAppend(
  statements: AppendStatements,
  file: { source: string; filePath: string },
  append: EventStoreAppend,
): { fileId: number; nextEventIndex: number; nextSessionEventIndex: number } | undefined {
  const row = statements.selectFile.get(file.source, file.filePath);
  const fileId = toNonNegativeInteger(row?.id);

  if (fileId === undefined || row?.fingerprint !== append.expectedFingerprint) {
    return undefined;
  }

  const { replaced } = append;
  statements.deleteLastEvents.run(fileId, fileId, replaced.usage ?? 0);
  statements.deleteLastToolCalls.run(fileId, fileId, replaced.tool_call ?? 0);
  statements.deleteLastMessages.run(fileId, fileId, replaced.message ?? 0);

  return {
    fileId,
    nextEventIndex: toNonNegativeInteger(statements.nextEventIndex.get(fileId)?.next) ?? 0,
    nextSessionEventIndex:
      toNonNegativeInteger(statements.nextSessionEventIndex.get(fileId, fileId)?.next) ?? 0,
  };
}
