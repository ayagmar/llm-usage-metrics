import { pluralize } from '../../utils/pluralize.js';
import { formatSqliteError, isBusyOrLockedSqliteError } from './sqlite-errors.js';

export type SleepFn = (delayMs: number) => Promise<void>;

/**
 * Rewrites a read error with the `<source> DB` message templates, keeping it as `cause`.
 * `source` is the product name users know, such as `OpenCode` or `Goose`.
 */
export function toSqliteDbReadError(
  error: unknown,
  source: string,
  dbPath: string,
  attempts: number,
): Error {
  if (isBusyOrLockedSqliteError(error)) {
    return new Error(
      `${source} DB is busy/locked: ${dbPath}. Retries exhausted after ${pluralize(attempts, 'attempt')}. Close active ${source} processes and retry.`,
      { cause: error },
    );
  }

  return new Error(`Could not read ${source} DB at ${dbPath}: ${formatSqliteError(error)}`, {
    cause: error,
  });
}

/**
 * The adapter's `maxBusyRetries` option, or `fallback` when unset. Anything but a
 * non-negative integer throws, naming the source.
 */
export function resolveMaxBusyRetries(
  source: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `${source} maxBusyRetries must be a non-negative integer (0 disables retries), got ${String(value)}`,
    );
  }

  return value;
}

/**
 * Runs `operation` until it succeeds or fails with an error that is not busy/locked, then
 * rewrites the error with `toSqliteDbReadError`. Wrap only work done before the first
 * yield, so a retry never yields a row twice.
 */
export async function runWithBusyRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    source: string;
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

      throw toSqliteDbReadError(error, options.source, options.dbPath, options.maxBusyRetries + 1);
    }
  }

  throw new Error(`Unexpected ${options.source} retry state: loop exhausted without result`);
}
