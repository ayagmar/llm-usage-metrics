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

export function runTransaction(database: EventStoreDatabase, task: () => void): void {
  database.exec('BEGIN IMMEDIATE');

  try {
    task();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
