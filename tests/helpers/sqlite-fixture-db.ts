import { createRequire } from 'node:module';

import { installSqliteWarningFilter } from '../../src/cli/sqlite-warning-filter.js';

export type FixtureDatabaseSync = new (filePath: string) => {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...args: unknown[]) => void };
  close: () => void;
};

const require = createRequire(import.meta.url);

/**
 * Runs a `node:sqlite` load with the CLI's warning filter in place, as the CLI entry does;
 * in-process tests never run that entry.
 */
export function withSuppressedSqliteExperimentalWarning<T>(load: () => T): T {
  installSqliteWarningFilter();
  return load();
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
