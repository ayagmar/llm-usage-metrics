import { computeEventContentHash } from '@ayagmar/agent-sessions';
import { loadNodeSqliteModule } from '@ayagmar/agent-sessions/internal';

import type { UsageEvent } from '../../src/domain/usage-event.js';
import type { EventStoreSqliteModule } from '../../src/persistence/event-store-database.js';

/** The schema 0.11.0 wrote: schema v4, events keyed by source and path. */
const V4_SCHEMA_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  skipped_rows INTEGER NOT NULL,
  skipped_row_reasons TEXT,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (source, file_path)
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  repo_root TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd REAL,
  cost_mode TEXT NOT NULL,
  content_hash TEXT,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX events_file ON events(source, file_path, event_index);
CREATE INDEX events_content_hash ON events(content_hash);
CREATE TABLE override_only_files (
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  PRIMARY KEY (source, file_path)
);
INSERT INTO meta (key, value) VALUES ('schemaVersion', '4');
`;

export type V4StoredFile = {
  source: string;
  filePath: string;
  fingerprint: string;
  events: readonly UsageEvent[];
  skippedRows?: number;
  ingestedAt?: number;
};

/** Writes a v4 store as 0.11.0 left it, with `files` and their events, and `meta`. */
export async function writeV4Store(
  storePath: string,
  files: readonly V4StoredFile[],
  meta: ReadonlyMap<string, string> = new Map(),
) {
  const sqlite = (await loadNodeSqliteModule('Test')) as unknown as EventStoreSqliteModule;
  const database = new sqlite.DatabaseSync(storePath);

  try {
    database.exec('PRAGMA journal_mode=WAL');
    database.exec(V4_SCHEMA_SQL);
    const insertMeta = database.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)');

    for (const [key, value] of meta) {
      insertMeta.run(key, value);
    }

    const insertFile = database.prepare(
      'INSERT INTO files (source, file_path, fingerprint, skipped_rows, ingested_at) VALUES (?, ?, ?, ?, ?)',
    );
    const insertEvent = database.prepare(
      [
        'INSERT INTO events (source, file_path, event_index, session_id, timestamp, model,',
        '  provider, repo_root, input_tokens, output_tokens, reasoning_tokens,',
        '  cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, total_tokens,',
        '  content_hash, cost_usd, cost_mode)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ].join('\n'),
    );

    // One transaction: a commit per row fsyncs per row on a disk-backed temp dir.
    database.exec('BEGIN');

    for (const file of files) {
      insertFile.run(
        file.source,
        file.filePath,
        file.fingerprint,
        file.skippedRows ?? 0,
        file.ingestedAt ?? 1,
      );
      file.events.forEach((event, eventIndex) => {
        insertEvent.run(
          file.source,
          file.filePath,
          eventIndex,
          event.sessionId,
          event.timestamp,
          event.model ?? null,
          event.provider ?? null,
          event.repoRoot ?? null,
          event.inputTokens,
          event.outputTokens,
          event.reasoningTokens,
          event.cacheReadTokens,
          event.cacheWriteTokens,
          event.cacheWrite1hTokens,
          event.totalTokens,
          computeEventContentHash(event),
          event.costUsd ?? null,
          event.costMode,
        );
      });
    }

    database.exec('COMMIT');
  } finally {
    database.close();
  }
}
