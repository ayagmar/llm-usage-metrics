import path from 'node:path';

import type { UsageEvent } from '../../domain/usage-event.js';
import { pathExists, pathIsFile, pathReadable } from '../../utils/fs-helpers.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../source-adapter.js';
import { getDefaultOpenCodeDbPathCandidates } from './opencode-db-path-resolver.js';
import { loadNodeSqliteModule, type SqliteModule } from './node-sqlite-loader.js';
import { parseOpenCodeMessageRows } from './opencode-row-parser.js';
import { runWithBusyRetries, type SleepFn } from './opencode-retry-policy.js';
import { queryOpenCodeMessageRows } from './opencode-sqlite-query.js';

const DEFAULT_BUSY_RETRY_COUNT = 2;
const DEFAULT_BUSY_RETRY_DELAY_MS = 50;

type PathPredicate = (filePath: string) => Promise<boolean>;

export type OpenCodeSourceAdapterOptions = {
  dbPath?: string;
  resolveDefaultDbPaths?: () => string[];
  pathExists?: PathPredicate;
  pathReadable?: PathPredicate;
  pathIsFile?: PathPredicate;
  loadSqliteModule?: () => Promise<SqliteModule>;
  maxBusyRetries?: number;
  busyRetryDelayMs?: number;
  sleep?: SleepFn;
};

function isBlankText(value: string): boolean {
  return value.trim().length === 0;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

// `-wal` holds commits that are not checkpointed into the database file yet. `-shm` is
// only an index of it, and a read-only open rewrites it, so keying on it would miss the
// parse cache on every run.
function getOpenCodeParseDependencies(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-journal`];
}

export class OpenCodeSourceAdapter implements SourceAdapter {
  public readonly id = 'opencode' as const;
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
    this.explicitDbPath = options.dbPath;
    this.resolveDefaultDbPaths =
      options.resolveDefaultDbPaths ?? getDefaultOpenCodeDbPathCandidates;
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
        throw new Error('--opencode-db must be a non-empty path');
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

  public async parseFile(dbPath: string): Promise<UsageEvent[]> {
    const parseDiagnostics = await this.parseFileWithDiagnostics(dbPath);
    return parseDiagnostics.events;
  }

  public async getParseDependencies(dbPath: string): Promise<string[]> {
    if (isBlankText(dbPath)) {
      return [];
    }

    return getOpenCodeParseDependencies(dbPath.trim());
  }

  public async parseFileWithDiagnostics(dbPath: string): Promise<SourceParseFileDiagnostics> {
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

    return runWithBusyRetries(() => this.parseFileOnce(normalizedDbPath), {
      dbPath: normalizedDbPath,
      maxBusyRetries: this.maxBusyRetries,
      busyRetryDelayMs: this.busyRetryDelayMs,
      sleep: this.sleep,
    });
  }

  private async parseFileOnce(dbPath: string): Promise<SourceParseFileDiagnostics> {
    const sqlite = await this.loadSqliteModule();
    const database = new sqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 0 });

    try {
      const messageRows = queryOpenCodeMessageRows(database);
      return parseOpenCodeMessageRows(messageRows, this.id);
    } finally {
      database.close();
    }
  }
}
