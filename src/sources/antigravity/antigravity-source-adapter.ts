import path from 'node:path';

import type { UsageEvent } from '../../domain/usage-event.js';
import { discoverFiles } from '../../utils/discover-files.js';
import { pathExists, pathIsDirectory, pathIsFile, pathReadable } from '../../utils/fs-helpers.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import { isBlankText } from '../parsing-utils.js';
import type {
  SourceAdapter,
  SourceAdapterPathOptions,
  SourceParseFileDiagnostics,
} from '../source-adapter.js';
import { loadNodeSqliteModule, type SqliteModule } from '../opencode/node-sqlite-loader.js';
import { getDefaultAntigravityConversationsDir } from './antigravity-path-resolver.js';
import {
  parseAntigravityMetadataBlob,
  parseAntigravitySessionCreatedAt,
} from './antigravity-row-parser.js';

type PathPredicate = (filePath: string) => Promise<boolean>;

type AntigravitySqliteRow = {
  data?: unknown;
};

export type AntigravitySourceAdapterOptions = SourceAdapterPathOptions & {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  pathExists?: PathPredicate;
  pathReadable?: PathPredicate;
  pathIsDirectory?: PathPredicate;
  pathIsFile?: PathPredicate;
  loadSqliteModule?: () => Promise<SqliteModule>;
};

function getAntigravityParseDependencies(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
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

function queryRows(database: InstanceType<SqliteModule['DatabaseSync']>): AntigravitySqliteRow[] {
  return database.prepare('SELECT data FROM gen_metadata ORDER BY idx').all();
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

export class AntigravitySourceAdapter implements SourceAdapter {
  public readonly id = 'antigravity' as const;
  public readonly capabilities = {
    fixedProviderRoots: ['google'],
  } as const;

  private readonly conversationsDir: string;
  private readonly requireDir: boolean;
  private readonly pathExists: PathPredicate;
  private readonly pathReadable: PathPredicate;
  private readonly pathIsDirectory: PathPredicate;
  private readonly pathIsFile: PathPredicate;
  private readonly loadSqliteModule: () => Promise<SqliteModule>;

  public constructor(options: AntigravitySourceAdapterOptions = {}) {
    this.conversationsDir =
      options.dir ??
      getDefaultAntigravityConversationsDir({
        env: options.env,
        homeDir: options.homeDir,
      });
    this.requireDir = options.requireDir ?? false;
    this.pathExists = options.pathExists ?? pathExists;
    this.pathReadable = options.pathReadable ?? pathReadable;
    this.pathIsDirectory = options.pathIsDirectory ?? pathIsDirectory;
    this.pathIsFile = options.pathIsFile ?? pathIsFile;
    this.loadSqliteModule = options.loadSqliteModule ?? loadNodeSqliteModule;
  }

  private getNormalizedConversationsDir(): string {
    if (isBlankText(this.conversationsDir)) {
      throw new Error('Antigravity conversations directory must be a non-empty path');
    }

    return this.conversationsDir.trim();
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

  public async parseFile(dbPath: string): Promise<UsageEvent[]> {
    const parseDiagnostics = await this.parseFileWithDiagnostics(dbPath);
    return parseDiagnostics.events;
  }

  public async getParseDependencies(dbPath: string): Promise<string[]> {
    if (isBlankText(dbPath)) {
      return [];
    }

    return getAntigravityParseDependencies(dbPath.trim());
  }

  public async parseFileWithDiagnostics(dbPath: string): Promise<SourceParseFileDiagnostics> {
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

    const sqlite = await this.loadSqliteModule();
    const database = new sqlite.DatabaseSync(normalizedDbPath, { readOnly: true, timeout: 0 });

    try {
      if (!hasSqliteTable(database, 'gen_metadata')) {
        return toParseDiagnostics([], 0, new Map());
      }

      const rows = queryRows(database);
      const fallbackTimestamp = querySessionCreatedAt(database);
      const events: UsageEvent[] = [];
      const seenResponseIds = new Set<string>();
      let skippedRows = 0;
      const skippedRowReasons = new Map<string, number>();

      for (const row of rows) {
        const parsedRow = parseAntigravityMetadataBlob(row.data, {
          sessionId: path.basename(normalizedDbPath, path.extname(normalizedDbPath)),
          fallbackTimestamp,
          seenResponseIds,
        });

        if (parsedRow.responseId) {
          seenResponseIds.add(parsedRow.responseId);
        }

        if (parsedRow.event) {
          events.push(parsedRow.event);
        }

        if (parsedRow.skippedReason) {
          skippedRows++;
          incrementSkippedReason(skippedRowReasons, parsedRow.skippedReason);
        }
      }

      return toParseDiagnostics(events, skippedRows, skippedRowReasons);
    } finally {
      database.close();
    }
  }
}
