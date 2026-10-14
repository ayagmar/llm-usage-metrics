import { formatSqliteError, isBusyOrLockedSqliteError } from './sqlite-errors.js';

export type SleepFn = (delayMs: number) => Promise<void>;

export async function runWithBusyRetries<T>(
  operation: () => Promise<T>,
  options: {
    dbPath: string;
    maxBusyRetries: number;
    busyRetryDelayMs: number;
    sleep: SleepFn;
  },
): Promise<T> {
  for (let attempt = 0; attempt <= options.maxBusyRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const isBusy = isBusyOrLockedSqliteError(error);

      if (isBusy && attempt < options.maxBusyRetries) {
        await options.sleep(options.busyRetryDelayMs * (attempt + 1));
        continue;
      }

      if (isBusy) {
        throw new Error(
          `OpenCode DB is busy/locked: ${options.dbPath}. Retries exhausted after ${options.maxBusyRetries + 1} attempt(s). Close active OpenCode processes and retry.`,
          { cause: error },
        );
      }

      throw new Error(
        `Could not read OpenCode DB at ${options.dbPath}: ${formatSqliteError(error)}`,
        { cause: error },
      );
    }
  }

  throw new Error('Unexpected OpenCode retry state: loop exhausted without result');
}
