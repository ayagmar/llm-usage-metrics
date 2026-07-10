import { createRequire } from 'node:module';

import { asRecord } from '../../utils/as-record.js';
import { withSuppressedSqliteExperimentalWarning } from './sqlite-warning-suppression.js';

export type SqliteModule = {
  DatabaseSync: new (
    filePath: string,
    options?: {
      readOnly?: boolean;
      timeout?: number;
    },
  ) => {
    prepare: (sql: string) => {
      all: (...anonymousParameters: unknown[]) => Record<string, unknown>[];
      iterate?: (...anonymousParameters: unknown[]) => IterableIterator<Record<string, unknown>>;
    };
    close: () => void;
  };
};

type RequireFn = (moduleId: string) => unknown;

const require = createRequire(import.meta.url);

function isSqliteModule(value: unknown): value is SqliteModule {
  const moduleRecord = asRecord(value);
  return typeof moduleRecord?.DatabaseSync === 'function';
}

export function loadNodeSqliteModuleFromRequire(
  requireFn: RequireFn,
  consumerLabel = 'OpenCode source',
): SqliteModule {
  try {
    const moduleValue = withSuppressedSqliteExperimentalWarning(() => requireFn('node:sqlite'));

    if (!isSqliteModule(moduleValue)) {
      throw new Error('node:sqlite loaded but did not expose a DatabaseSync constructor.');
    }

    return moduleValue;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${consumerLabel} requires Node.js 24+ runtime with node:sqlite support: ${reason}`,
      { cause: error },
    );
  }
}

export async function loadNodeSqliteModule(consumerLabel?: string): Promise<SqliteModule> {
  return loadNodeSqliteModuleFromRequire(require, consumerLabel);
}
