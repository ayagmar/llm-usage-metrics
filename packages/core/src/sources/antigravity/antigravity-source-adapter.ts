import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { UsageEvent } from '../../domain/usage-event.js';
import { discoverFiles } from '../../utils/discover-files.js';
import { pathExists, pathIsDirectory, pathIsFile, pathReadable } from '../../utils/fs-helpers.js';
import { createReadDiagnostics, recordSkippedRow } from '../parse-diagnostics.js';
import { isBlankText } from '../parsing-utils.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceReadOptions,
} from '../source-adapter.js';
import { createSourceContext } from '../source-context.js';
import { iterateRows } from '../sqlite/iterate-rows.js';
import { loadNodeSqliteModule, type SqliteModule } from '../sqlite/node-sqlite-loader.js';
import {
  resolveMaxBusyRetries,
  runWithBusyRetries,
  toSqliteDbReadError,
  type SleepFn,
} from '../sqlite/retry-policy.js';
import { getDefaultAntigravityConversationsDir } from './antigravity-path-resolver.js';
import {
  parseAntigravityMetadataBlob,
  parseAntigravitySessionCreatedAt,
} from './antigravity-row-parser.js';

const DEFAULT_BUSY_RETRY_COUNT = 2;
const DEFAULT_BUSY_RETRY_DELAY_MS = 50;

type PathPredicate = (filePath: string) => Promise<boolean>;

type AntigravitySqliteRow = {
  data?: unknown;
};

type AntigravityMetadataRows = {
  database: InstanceType<SqliteModule['DatabaseSync']>;
  rows: Iterable<AntigravitySqliteRow>;
  fallbackTimestamp: string | undefined;
};

/** Options for `AntigravitySourceAdapter`. */
export type AntigravitySourceAdapterOptions = SourceAdapterPathOptions & {
  /** Test seam: replaces the file system check. @internal */
  pathExists?: PathPredicate;
  /** Test seam: replaces the file system check. @internal */
  pathReadable?: PathPredicate;
  /** Test seam: replaces the file system check. @internal */
  pathIsDirectory?: PathPredicate;
  /** Test seam: replaces the file system check. @internal */
  pathIsFile?: PathPredicate;
  /** Test seam: replaces the node:sqlite loader. @internal */
  loadSqliteModule?: (consumerLabel: string) => Promise<SqliteModule>;
  /** Retries of a read that finds the database busy or locked. */
  maxBusyRetries?: number;
  /** Delay between those retries. */
  busyRetryDelayMs?: number;
  /** Test seam: replaces the busy-retry delay. @internal */
  sleep?: SleepFn;
};

// `-wal` holds commits that are not checkpointed into the database file yet. `-shm` is
// only an index of it, and a read-only open rewrites it, so keying on it would miss the
// parse cache on every run.
function getAntigravityParseDependencies(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-journal`];
}

function hasSqliteTable(
  database: InstanceType<SqliteModule['DatabaseSync']>,
  tableName: string,
): boolean {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .all(tableName);

  return rows.length > 0;
}

function queryRows(
  database: InstanceType<SqliteModule['DatabaseSync']>,
): Iterable<AntigravitySqliteRow> {
  return iterateRows(database.prepare('SELECT data FROM gen_metadata ORDER BY idx'));
}

function querySessionCreatedAt(
  database: InstanceType<SqliteModule['DatabaseSync']>,
): string | undefined {
  if (!hasSqliteTable(database, 'trajectory_metadata_blob')) {
    return undefined;
  }

  const rows = database.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').all();

  return parseAntigravitySessionCreatedAt(rows[0]?.data);
}

/**
 * Antigravity CLI conversations (SQLite), from `$GEMINI_CLI_HOME/antigravity-cli/conversations`
 * (default `~/.gemini/antigravity-cli/conversations`). Needs `node:sqlite`.
 */
export class AntigravitySourceAdapter implements SourceAdapter {
  public readonly id = 'antigravity' as const;
  public readonly capabilities = { kinds: ['usage'] } as const;
  public readonly parserVersion = 2;

  private readonly conversationsDir: string;
  private readonly requireDir: boolean;
  private readonly pathExists: PathPredicate;
  private readonly pathReadable: PathPredicate;
  private readonly pathIsDirectory: PathPredicate;
  private readonly pathIsFile: PathPredicate;
  private readonly loadSqliteModule: (consumerLabel: string) => Promise<SqliteModule>;
  private readonly maxBusyRetries: number;
  private readonly busyRetryDelayMs: number;
  private readonly sleep: SleepFn;

  public constructor(options: AntigravitySourceAdapterOptions = {}) {
    this.conversationsDir =
      options.dir ??
      getDefaultAntigravityConversationsDir(options.context ?? createSourceContext());
    this.requireDir = options.requireDir ?? false;
    this.pathExists = options.pathExists ?? pathExists;
    this.pathReadable = options.pathReadable ?? pathReadable;
    this.pathIsDirectory = options.pathIsDirectory ?? pathIsDirectory;
    this.pathIsFile = options.pathIsFile ?? pathIsFile;
    this.loadSqliteModule = options.loadSqliteModule ?? loadNodeSqliteModule;
    this.maxBusyRetries = resolveMaxBusyRetries(
      'Antigravity',
      options.maxBusyRetries,
      DEFAULT_BUSY_RETRY_COUNT,
    );
    this.busyRetryDelayMs = Math.max(1, options.busyRetryDelayMs ?? DEFAULT_BUSY_RETRY_DELAY_MS);
    this.sleep = options.sleep ?? sleep;
  }

  private getNormalizedConversationsDir(): string {
    if (isBlankText(this.conversationsDir)) {
      throw new Error('Antigravity conversations directory must be a non-empty path');
    }

    return this.conversationsDir.trim();
  }

  public getSearchPaths(): string[] {
    return [this.conversationsDir].map((searchPath) => searchPath.trim());
  }

  public async discoverFiles(): Promise<string[]> {
    const conversationsDir = this.getNormalizedConversationsDir();
    const readable = await this.pathReadable(conversationsDir);

    if (!readable) {
      if (this.requireDir) {
        throw new Error(
          `Antigravity conversations directory is missing or unreadable: ${conversationsDir}`,
        );
      }

      return [];
    }

    const isDirectory = await this.pathIsDirectory(conversationsDir);

    if (!isDirectory) {
      if (this.requireDir) {
        throw new Error(
          `Antigravity conversations directory is not a directory: ${conversationsDir}`,
        );
      }

      return [];
    }

    return discoverFiles(conversationsDir, {
      extension: '.db',
      recursive: false,
    });
  }

  public async getParseDependencies(dbPath: string): Promise<string[]> {
    if (isBlankText(dbPath)) {
      return [];
    }

    return getAntigravityParseDependencies(dbPath.trim());
  }

  public async *read(dbPath: string, options: SourceReadOptions = {}): AsyncGenerator<UsageEvent> {
    const diagnostics = options.diagnostics ?? createReadDiagnostics();

    if (isBlankText(dbPath)) {
      throw new Error('Antigravity DB path must be a non-empty path');
    }

    const normalizedDbPath = dbPath.trim();
    const readable = await this.pathReadable(normalizedDbPath);

    if (!readable) {
      throw new Error(`Antigravity DB path is unreadable: ${normalizedDbPath}`);
    }

    if ((await this.pathExists(normalizedDbPath)) && !(await this.pathIsFile(normalizedDbPath))) {
      throw new Error(`Antigravity DB path is not a file: ${normalizedDbPath}`);
    }

    let attempts = 0;
    const metadataRows = await runWithBusyRetries(
      (attempt) => {
        attempts = attempt + 1;
        return this.openMetadataRows(normalizedDbPath);
      },
      {
        source: 'Antigravity',
        dbPath: normalizedDbPath,
        maxBusyRetries: this.maxBusyRetries,
        busyRetryDelayMs: this.busyRetryDelayMs,
        sleep: this.sleep,
      },
    );

    if (!metadataRows) {
      return;
    }

    const { database, rows, fallbackTimestamp } = metadataRows;
    const sessionId = path.basename(normalizedDbPath, path.extname(normalizedDbPath));
    const seenResponseIds = new Set<string>();

    try {
      try {
        for (const row of rows) {
          const parsedRow = parseAntigravityMetadataBlob(row.data, {
            sessionId,
            fallbackTimestamp,
            seenResponseIds,
          });

          if (parsedRow.responseId) {
            seenResponseIds.add(parsedRow.responseId);
          }

          if (parsedRow.skippedReason) {
            recordSkippedRow(diagnostics, parsedRow.skippedReason);
          }

          if (parsedRow.event) {
            yield parsedRow.event;
          }
        }
      } finally {
        database.close();
      }
    } catch (error) {
      throw toSqliteDbReadError(error, 'Antigravity', normalizedDbPath, attempts);
    }
  }

  // Does every query that runs before the first yield, so a busy database fails here,
  // inside the retry, rather than after a row was yielded. Undefined, with the database
  // closed, when there is no gen_metadata table.
  private async openMetadataRows(dbPath: string): Promise<AntigravityMetadataRows | undefined> {
    const sqlite = await this.loadSqliteModule('Antigravity');
    const database = new sqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 0 });

    try {
      if (!hasSqliteTable(database, 'gen_metadata')) {
        database.close();
        return undefined;
      }

      // The first gen_metadata row is pulled before the fallback timestamp query, so its
      // errors take precedence as they did when every row was read up front.
      const rows = queryRows(database);
      const fallbackTimestamp = querySessionCreatedAt(database);

      return { database, rows, fallbackTimestamp };
    } catch (error) {
      database.close();
      throw error;
    }
  }
}
