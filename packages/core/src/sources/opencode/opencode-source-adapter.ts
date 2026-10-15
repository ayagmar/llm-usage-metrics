import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { UsageEvent } from '../../domain/usage-event.js';
import { pathExists, pathIsFile, pathReadable } from '../../utils/fs-helpers.js';
import { createReadDiagnostics } from '../parse-diagnostics.js';
import type { SourceAdapter, SourceReadOptions } from '../source-adapter.js';
import { createSourceContext, type SourceContext } from '../source-context.js';
import { getDefaultOpenCodeDbPathCandidates } from './opencode-db-path-resolver.js';
import { loadNodeSqliteModule, type SqliteModule } from '../sqlite/node-sqlite-loader.js';
import { parseOpenCodeMessageRow } from './opencode-row-parser.js';
import { runWithBusyRetries, toSqliteDbReadError, type SleepFn } from '../sqlite/retry-policy.js';
import { queryOpenCodeMessageRows, type OpenCodeSqliteRow } from './opencode-sqlite-query.js';
import { isBlankText } from '../parsing-utils.js';

const DEFAULT_BUSY_RETRY_COUNT = 2;
const DEFAULT_BUSY_RETRY_DELAY_MS = 50;

type PathPredicate = (filePath: string) => Promise<boolean>;

type OpenCodeMessageRows = {
  database: InstanceType<SqliteModule['DatabaseSync']>;
  rows: IterableIterator<OpenCodeSqliteRow>;
};

/** Options for `OpenCodeSourceAdapter`. */
export type OpenCodeSourceAdapterOptions = {
  /** The database to read; the platform's default locations when omitted. */
  dbPath?: string;
  /** Test seam: default database paths tried when no dbPath is given. @internal */
  resolveDefaultDbPaths?: () => string[];
  /** Test seam: replaces the file system check. @internal */
  pathExists?: PathPredicate;
  /** Test seam: replaces the file system check. @internal */
  pathReadable?: PathPredicate;
  /** Test seam: replaces the file system check. @internal */
  pathIsFile?: PathPredicate;
  /** Test seam: replaces the node:sqlite loader. @internal */
  loadSqliteModule?: () => Promise<SqliteModule>;
  /** Retries of a read that finds the database busy or locked. */
  maxBusyRetries?: number;
  /** Delay between those retries. */
  busyRetryDelayMs?: number;
  /** Test seam: replaces the busy-retry delay. @internal */
  sleep?: SleepFn;
  context?: SourceContext;
};

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
  public readonly parserVersion = 2;

  private readonly explicitDbPath?: string;
  private readonly resolveDefaultDbPaths: () => string[];
  private readonly pathExists: PathPredicate;
  private readonly pathReadable: PathPredicate;
  private readonly pathIsFile: PathPredicate;
  private readonly loadSqliteModule: () => Promise<SqliteModule>;
  private readonly maxBusyRetries: number;
  private readonly busyRetryDelayMs: number;
  private readonly sleep: SleepFn;

  public constructor(options: OpenCodeSourceAdapterOptions = {}) {
    const context = options.context ?? createSourceContext();

    this.explicitDbPath = options.dbPath;
    this.resolveDefaultDbPaths =
      options.resolveDefaultDbPaths ?? (() => getDefaultOpenCodeDbPathCandidates(context));
    this.pathExists = options.pathExists ?? pathExists;
    this.pathReadable = options.pathReadable ?? pathReadable;
    this.pathIsFile = options.pathIsFile ?? pathIsFile;
    this.loadSqliteModule = options.loadSqliteModule ?? loadNodeSqliteModule;
    this.maxBusyRetries = Math.max(0, options.maxBusyRetries ?? DEFAULT_BUSY_RETRY_COUNT);
    this.busyRetryDelayMs = Math.max(1, options.busyRetryDelayMs ?? DEFAULT_BUSY_RETRY_DELAY_MS);
    this.sleep = options.sleep ?? sleep;
  }

  public getSearchPaths(): string[] {
    return this.explicitDbPath !== undefined
      ? [this.explicitDbPath.trim()]
      : this.resolveDefaultDbPaths();
  }

  public async discoverFiles(): Promise<string[]> {
    if (this.explicitDbPath !== undefined) {
      if (isBlankText(this.explicitDbPath)) {
        throw new Error('dbPath must be a non-empty path');
      }

      const explicitDbPath = this.explicitDbPath.trim();
      const readable = await this.pathReadable(explicitDbPath);

      if (!readable) {
        throw new Error(`OpenCode DB path is missing or unreadable: ${explicitDbPath}`);
      }

      if ((await this.pathExists(explicitDbPath)) && !(await this.pathIsFile(explicitDbPath))) {
        throw new Error(`OpenCode DB path is not a file: ${explicitDbPath}`);
      }

      return [explicitDbPath];
    }

    let firstUnreadableCandidatePath: string | undefined;
    let selectedDirectory: string | undefined;
    const selectedPaths: string[] = [];

    // OpenCode keeps one database per release channel (opencode.db, opencode-<channel>.db),
    // each with its own sessions, so every readable one in the first directory counts.
    for (const candidatePath of this.resolveDefaultDbPaths()) {
      const directory = path.dirname(candidatePath);

      if (selectedDirectory !== undefined && directory !== selectedDirectory) {
        break;
      }

      if (await this.pathReadable(candidatePath)) {
        if ((await this.pathExists(candidatePath)) && !(await this.pathIsFile(candidatePath))) {
          throw new Error(`OpenCode DB path is not a file: ${candidatePath}`);
        }

        selectedDirectory = directory;
        selectedPaths.push(candidatePath);
        continue;
      }

      if (!firstUnreadableCandidatePath && (await this.pathExists(candidatePath))) {
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
    const readable = await this.pathReadable(normalizedDbPath);

    if (!readable) {
      throw new Error(`OpenCode DB path is unreadable: ${normalizedDbPath}`);
    }

    if ((await this.pathExists(normalizedDbPath)) && !(await this.pathIsFile(normalizedDbPath))) {
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
        maxBusyRetries: this.maxBusyRetries,
        busyRetryDelayMs: this.busyRetryDelayMs,
        sleep: this.sleep,
      },
    );

    try {
      try {
        for (const row of rows) {
          const event = parseOpenCodeMessageRow(row, this.id, diagnostics);

          if (event) {
            yield event;
          }
        }
      } finally {
        database.close();
      }
    } catch (error) {
      throw toSqliteDbReadError(error, 'OpenCode', normalizedDbPath, attempts);
    }
  }

  private async openMessageRows(dbPath: string): Promise<OpenCodeMessageRows> {
    const sqlite = await this.loadSqliteModule();
    const database = new sqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 0 });

    try {
      return { database, rows: queryOpenCodeMessageRows(database) };
    } catch (error) {
      database.close();
      throw error;
    }
  }
}
