import { formatSqliteError, isBusyOrLockedSqliteError } from './sqlite-errors.js';

export type SleepFn = (delayMs: number) => Promise<void>;

/** Rewrites a read error with the OpenCode DB message templates, keeping it as `cause`. */
export function toOpenCodeDbReadError(error: unknown, dbPath: string, attempts: number): Error {
  if (isBusyOrLockedSqliteError(error)) {
    return new Error(
      `OpenCode DB is busy/locked: ${dbPath}. Retries exhausted after ${attempts} attempt(s). Close active OpenCode processes and retry.`,
      { cause: error },
    );
  }

  return new Error(`Could not read OpenCode DB at ${dbPath}: ${formatSqliteError(error)}`, {
    cause: error,
  });
}

/** Runs `operation` until it succeeds or fails with an error that is not busy/locked. */
export async function runWithBusyRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    dbPath: string;
    maxBusyRetries: number;
    busyRetryDelayMs: number;
    sleep: SleepFn;
  },
): Promise<T> {
  for (let attempt = 0; attempt <= options.maxBusyRetries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (isBusyOrLockedSqliteError(error) && attempt < options.maxBusyRetries) {
        await options.sleep(options.busyRetryDelayMs * (attempt + 1));
        continue;
      }

      throw toOpenCodeDbReadError(error, options.dbPath, options.maxBusyRetries + 1);
    }
  }

  throw new Error('Unexpected OpenCode retry state: loop exhausted without result');
}
