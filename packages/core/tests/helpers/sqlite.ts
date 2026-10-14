import { createRequire } from 'node:module';

export type FixtureDatabaseSync = new (filePath: string) => {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...args: unknown[]) => void };
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
