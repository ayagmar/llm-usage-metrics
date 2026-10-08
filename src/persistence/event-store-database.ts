import { asRecord } from '../utils/as-record.js';

export type EventStoreStatement = {
  all: (...parameters: unknown[]) => Record<string, unknown>[];
  get: (...parameters: unknown[]) => Record<string, unknown> | undefined;
  run: (...parameters: unknown[]) => unknown;
  setReturnArrays: (enabled: boolean) => void;
};

export type EventStoreDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => EventStoreStatement;
  close: () => void;
};

export type EventStoreSqliteModule = {
  DatabaseSync: new (
    filePath: string,
    options?: {
      readOnly?: boolean;
      timeout?: number;
    },
  ) => EventStoreDatabase;
};

export type LoadEventStoreSqliteModule = () => Promise<unknown>;

export type EventStore = {
  database: EventStoreDatabase;
  filePath: string;
  statements: {
    getFileEntry?: EventStoreStatement;
    selectFileEvents?: EventStoreStatement;
    deleteFileEvents?: EventStoreStatement;
    insertEvent?: EventStoreStatement;
    upsertFile?: EventStoreStatement;
  };
};

export function isEventStoreSqliteModule(value: unknown): value is EventStoreSqliteModule {
  const moduleRecord = asRecord(value);
  return typeof moduleRecord?.DatabaseSync === 'function';
}

export function toNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.trunc(value);
}

export function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

export function toText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

const databasesInTransaction = new WeakSet<EventStoreDatabase>();

/**
 * Runs `task` in a write transaction. A nested call joins the outer transaction, so it is
 * atomic only as part of it: a caller that catches a nested error and carries on commits
 * the work done before it.
 */
export function runTransaction<T>(database: EventStoreDatabase, task: () => T): T {
  if (databasesInTransaction.has(database)) {
    return task();
  }

  database.exec('BEGIN IMMEDIATE');
  databasesInTransaction.add(database);

  try {
    const result = task();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    databasesInTransaction.delete(database);
  }
}
