import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { pathExists, pathIsFile, pathReadable } from '../../utils/fs-helpers.js';
import { isBlankText } from '../parsing-utils.js';
import { createSourceContext, readEnvPath, type SourceContext } from '../source-context.js';
import { loadNodeSqliteModule, type SqliteModule } from './node-sqlite-loader.js';
import { resolveMaxBusyRetries, type SleepFn } from './retry-policy.js';

const DEFAULT_BUSY_RETRY_COUNT = 2;
const DEFAULT_BUSY_RETRY_DELAY_MS = 50;

type PathPredicate = (filePath: string) => Promise<boolean>;

/** Options of a source that reads one SQLite database. */
export type SqliteDbSourceOptions = {
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
  loadSqliteModule?: (consumerLabel: string) => Promise<SqliteModule>;
  /** Retries of a read that finds the database busy or locked. */
  maxBusyRetries?: number;
  /** Delay between those retries. */
  busyRetryDelayMs?: number;
  /** Test seam: replaces the busy-retry delay. @internal */
  sleep?: SleepFn;
  context?: SourceContext;
};

/** `SqliteDbSourceOptions` with the defaults applied. */
export type SqliteDbSource = {
  /** The name error messages use, such as `Goose`. */
  sourceName: string;
  explicitDbPath?: string;
  resolveDefaultDbPaths: () => string[];
  pathExists: PathPredicate;
  pathReadable: PathPredicate;
  pathIsFile: PathPredicate;
  loadSqliteModule: (consumerLabel: string) => Promise<SqliteModule>;
  maxBusyRetries: number;
  busyRetryDelayMs: number;
  sleep: SleepFn;
};

export function createSqliteDbSource(
  sourceName: string,
  options: SqliteDbSourceOptions,
  getDefaultDbPaths: (context: SourceContext) => string[],
): SqliteDbSource {
  const context = options.context ?? createSourceContext();

  return {
    sourceName,
    explicitDbPath: options.dbPath,
    resolveDefaultDbPaths: options.resolveDefaultDbPaths ?? (() => getDefaultDbPaths(context)),
    pathExists: options.pathExists ?? pathExists,
    pathReadable: options.pathReadable ?? pathReadable,
    pathIsFile: options.pathIsFile ?? pathIsFile,
    loadSqliteModule: options.loadSqliteModule ?? loadNodeSqliteModule,
    maxBusyRetries: resolveMaxBusyRetries(
      sourceName,
      options.maxBusyRetries,
      DEFAULT_BUSY_RETRY_COUNT,
    ),
    busyRetryDelayMs: Math.max(1, options.busyRetryDelayMs ?? DEFAULT_BUSY_RETRY_DELAY_MS),
    sleep: options.sleep ?? sleep,
  };
}

export function getSqliteDbSearchPaths(source: SqliteDbSource): string[] {
  return source.explicitDbPath !== undefined
    ? [source.explicitDbPath.trim()]
    : source.resolveDefaultDbPaths();
}

/** The checked `dbPath` the source was given. */
export async function discoverExplicitSqliteDb(
  source: SqliteDbSource,
  dbPath: string,
): Promise<string[]> {
  if (isBlankText(dbPath)) {
    throw new Error('dbPath must be a non-empty path');
  }

  const explicitDbPath = dbPath.trim();
  const readable = await source.pathReadable(explicitDbPath);

  if (!readable) {
    throw new Error(`${source.sourceName} DB path is missing or unreadable: ${explicitDbPath}`);
  }

  if ((await source.pathExists(explicitDbPath)) && !(await source.pathIsFile(explicitDbPath))) {
    throw new Error(`${source.sourceName} DB path is not a file: ${explicitDbPath}`);
  }

  return [explicitDbPath];
}

export function deduplicatePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function resolveXdgDataHome(context: SourceContext): string {
  return readEnvPath(context, 'XDG_DATA_HOME') ?? path.join(context.homeDir, '.local', 'share');
}

export function resolveWindowsRoamingBase(context: SourceContext): string | undefined {
  const userProfile = readEnvPath(context, 'USERPROFILE');

  return (
    readEnvPath(context, 'APPDATA') ??
    readEnvPath(context, 'LOCALAPPDATA') ??
    (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : undefined)
  );
}
