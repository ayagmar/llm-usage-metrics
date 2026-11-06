import path from 'node:path';

import type { UsageEvent } from '../../domain/usage-event.js';
import { createReadDiagnostics } from '../parse-diagnostics.js';
import type { SourceAdapter, SourceReadOptions } from '../source-adapter.js';
import { getDefaultOpenCodeDbPathCandidates } from './opencode-db-path-resolver.js';
import type { SqliteModule } from '../sqlite/node-sqlite-loader.js';
import { parseOpenCodeMessageRow } from './opencode-row-parser.js';
import { runWithBusyRetries, toSqliteDbReadError } from '../sqlite/retry-policy.js';
import {
  createSqliteDbSource,
  discoverExplicitSqliteDb,
  getSqliteDbSearchPaths,
  type SqliteDbSource,
  type SqliteDbSourceOptions,
} from '../sqlite/sqlite-db-source.js';
import { queryOpenCodeMessageRows, type OpenCodeSqliteRow } from './opencode-sqlite-query.js';
import { isBlankText } from '../parsing-utils.js';

type OpenCodeMessageRows = {
  database: InstanceType<SqliteModule['DatabaseSync']>;
  rows: IterableIterator<OpenCodeSqliteRow>;
};

/** Options for `OpenCodeSourceAdapter`. */
export type OpenCodeSourceAdapterOptions = SqliteDbSourceOptions;

// `-wal` holds commits that are not checkpointed into the database file yet. `-shm` is
// only an index of it, and a read-only open rewrites it, so keying on it would miss the
// parse cache on every run.
function getOpenCodeParseDependencies(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-journal`];
}

/**
 * OpenCode's database (SQLite), from `dbPath` or the platform's default locations
 * (`$XDG_DATA_HOME/opencode`, `~/.opencode`, Application Support or `%APPDATA%`). Needs
 * `node:sqlite`.
 */
export class OpenCodeSourceAdapter implements SourceAdapter {
  public readonly id = 'opencode' as const;
  public readonly capabilities = { kinds: ['usage'] } as const;
  public readonly parserVersion = 5;

  private readonly db: SqliteDbSource;

  public constructor(options: OpenCodeSourceAdapterOptions = {}) {
    this.db = createSqliteDbSource('OpenCode', options, getDefaultOpenCodeDbPathCandidates);
  }

  public getSearchPaths(): string[] {
    return getSqliteDbSearchPaths(this.db);
  }

  public async discoverFiles(): Promise<string[]> {
    if (this.db.explicitDbPath !== undefined) {
      return discoverExplicitSqliteDb(this.db, this.db.explicitDbPath);
    }

    let firstUnreadableCandidatePath: string | undefined;
    let selectedDirectory: string | undefined;
    const selectedPaths: string[] = [];

    // OpenCode keeps one database per release channel (opencode.db, opencode-<channel>.db),
    // each with its own sessions, so every readable one in the first directory counts.
    for (const candidatePath of this.db.resolveDefaultDbPaths()) {
      const directory = path.dirname(candidatePath);

      if (selectedDirectory !== undefined && directory !== selectedDirectory) {
        break;
      }

      if (await this.db.pathReadable(candidatePath)) {
        if (
          (await this.db.pathExists(candidatePath)) &&
          !(await this.db.pathIsFile(candidatePath))
        ) {
          throw new Error(`OpenCode DB path is not a file: ${candidatePath}`);
        }

        selectedDirectory = directory;
        selectedPaths.push(candidatePath);
        continue;
      }

      if (!firstUnreadableCandidatePath && (await this.db.pathExists(candidatePath))) {
        firstUnreadableCandidatePath = candidatePath;
      }
    }

    if (selectedPaths.length > 0) {
      // db.sqlite is a fallback name, read only when no opencode database sits beside it.
      const channelDbPaths = selectedPaths.filter(
        (candidatePath) => path.basename(candidatePath) !== 'db.sqlite',
      );
      return channelDbPaths.length > 0 ? channelDbPaths : selectedPaths;
    }

    if (firstUnreadableCandidatePath) {
      throw new Error(`OpenCode DB path is unreadable: ${firstUnreadableCandidatePath}`);
    }

    return [];
  }

  public async getParseDependencies(dbPath: string): Promise<string[]> {
    if (isBlankText(dbPath)) {
      return [];
    }

    return getOpenCodeParseDependencies(dbPath.trim());
  }

  /**
   * Busy retries cover opening the database, preparing the query and pulling its first
   * row, before anything is yielded or recorded. An error after that is not retried; it
   * is rewritten with the number of attempts the open took.
   */
  public async *read(dbPath: string, options: SourceReadOptions = {}): AsyncGenerator<UsageEvent> {
    const diagnostics = options.diagnostics ?? createReadDiagnostics();

    if (isBlankText(dbPath)) {
      throw new Error('OpenCode DB path must be a non-empty path');
    }

    const normalizedDbPath = dbPath.trim();
    const readable = await this.db.pathReadable(normalizedDbPath);

    if (!readable) {
      throw new Error(`OpenCode DB path is unreadable: ${normalizedDbPath}`);
    }

    if (
      (await this.db.pathExists(normalizedDbPath)) &&
      !(await this.db.pathIsFile(normalizedDbPath))
    ) {
      throw new Error(`OpenCode DB path is not a file: ${normalizedDbPath}`);
    }

    let attempts = 0;
    const { database, rows } = await runWithBusyRetries(
      (attempt) => {
        attempts = attempt + 1;
        return this.openMessageRows(normalizedDbPath);
      },
      {
        source: 'OpenCode',
        dbPath: normalizedDbPath,
        maxBusyRetries: this.db.maxBusyRetries,
        busyRetryDelayMs: this.db.busyRetryDelayMs,
        sleep: this.db.sleep,
      },
    );

    try {
      try {
        for (const row of rows) {
          yield* parseOpenCodeMessageRow(row, this.id, diagnostics);
        }
      } finally {
        database.close();
      }
    } catch (error) {
      throw toSqliteDbReadError(error, 'OpenCode', normalizedDbPath, attempts);
    }
  }

  private async openMessageRows(dbPath: string): Promise<OpenCodeMessageRows> {
    const sqlite = await this.db.loadSqliteModule('OpenCode');
    const database = new sqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 0 });

    try {
      return { database, rows: queryOpenCodeMessageRows(database) };
    } catch (error) {
      database.close();
      throw error;
    }
  }
}
