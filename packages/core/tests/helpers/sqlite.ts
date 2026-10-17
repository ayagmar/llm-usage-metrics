import { createRequire } from 'node:module';

export type FixtureDatabaseSync = new (
  filePath: string,
  options?: { timeout?: number },
) => {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    run: (...args: unknown[]) => void;
    all: (...args: unknown[]) => Record<string, unknown>[];
    get: (...args: unknown[]) => Record<string, unknown> | undefined;
    iterate: (...args: unknown[]) => IterableIterator<Record<string, unknown>>;
  };
  close: () => void;
};

const require = createRequire(import.meta.url);

const sqliteExperimentalWarningText =
  'SQLite is an experimental feature and might change at any time';

/**
 * Runs a `node:sqlite` load with Node's SQLite ExperimentalWarning dropped, so core tests
 * stay quiet without importing the CLI's warning filter. Other warnings pass through.
 */
export function withSuppressedSqliteExperimentalWarning<T>(load: () => T): T {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored as is below
  const originalEmitWarning = process.emitWarning;

  process.emitWarning = function (this: unknown, ...args: unknown[]): void {
    const [warning] = args;
    const message =
      warning instanceof Error ? warning.message : typeof warning === 'string' ? warning : '';

    if (message.includes(sqliteExperimentalWarningText)) {
      return;
    }

    Reflect.apply(originalEmitWarning, this, args);
  };

  try {
    return load();
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

/** `node:sqlite`'s DatabaseSync, or undefined on a runtime without it. */
export function loadDatabaseSync(): FixtureDatabaseSync | undefined {
  let sqliteModule: unknown;

  try {
    sqliteModule = withSuppressedSqliteExperimentalWarning(() => require('node:sqlite') as unknown);
  } catch {
    return undefined;
  }

  const moduleRecord = sqliteModule as { DatabaseSync?: unknown } | undefined;

  if (typeof moduleRecord?.DatabaseSync !== 'function') {
    return undefined;
  }

  return moduleRecord.DatabaseSync as FixtureDatabaseSync;
}

/** `node:sqlite`'s DatabaseSync; throws on a runtime without it. */
export function requireDatabaseSync(): FixtureDatabaseSync {
  const DatabaseSync = loadDatabaseSync();

  if (!DatabaseSync) {
    throw new Error('SQLite fixtures require node:sqlite DatabaseSync support.');
  }

  return DatabaseSync;
}

/** The database's journal mode, read on a connection of its own. */
export function readJournalMode(dbPath: string): unknown {
  const database = new (requireDatabaseSync())(dbPath);

  try {
    return database.prepare('PRAGMA journal_mode').get()?.journal_mode;
  } finally {
    database.close();
  }
}

/**
 * Whether another connection can take `BEGIN EXCLUSIVE` without waiting. In
 * `journal_mode=DELETE`, a reader that still holds a statement keeps it from doing so.
 */
export function canBeginExclusive(dbPath: string): boolean {
  const database = new (requireDatabaseSync())(dbPath, { timeout: 0 });

  try {
    database.exec('BEGIN EXCLUSIVE');
    database.exec('ROLLBACK');
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('database is locked')) {
      return false;
    }

    throw error;
  } finally {
    database.close();
  }
}
