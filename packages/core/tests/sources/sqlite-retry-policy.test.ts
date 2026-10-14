import { describe, expect, it, vi } from 'vitest';

import { runWithBusyRetries } from '../../src/sources/opencode/opencode-retry-policy.js';
import {
  formatSqliteError,
  isBusyOrLockedSqliteError,
} from '../../src/sources/opencode/opencode-sqlite-errors.js';

function createBusyError(message = 'database is locked'): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = 'SQLITE_BUSY';
  return error;
}

describe('opencode sqlite error helpers', () => {
  it('detects busy/locked errors by code and message patterns', () => {
    expect(isBusyOrLockedSqliteError(createBusyError())).toBe(true);
    expect(isBusyOrLockedSqliteError({ code: 'SQLITE_LOCKED' })).toBe(true);
    expect(isBusyOrLockedSqliteError(new Error('database table is locked'))).toBe(true);
    expect(isBusyOrLockedSqliteError(new Error('some other sqlite error'))).toBe(false);
  });

  it('formats sqlite errors with code when available', () => {
    const codedError = Object.assign(new Error('bad query'), { code: 'SQLITE_ERROR' });
    expect(formatSqliteError(codedError)).toBe('SQLITE_ERROR: bad query');
    expect(formatSqliteError(new Error('plain error'))).toBe('plain error');
    expect(formatSqliteError('unknown')).toBe('unknown');
  });
});

describe('opencode retry policy', () => {
  it('returns operation result without sleeping when first attempt succeeds', async () => {
    const sleepSpy = vi.fn(async () => undefined);
    const result = await runWithBusyRetries(async () => 'ok', {
      dbPath: '/tmp/opencode.db',
      maxBusyRetries: 2,
      busyRetryDelayMs: 10,
      sleep: sleepSpy,
    });

    expect(result).toBe('ok');
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('retries SQLITE busy failures with linear backoff and succeeds', async () => {
    const sleepSpy = vi.fn(async () => undefined);
    let attemptCount = 0;

    const result = await runWithBusyRetries(
      async () => {
        attemptCount += 1;

        if (attemptCount === 1) {
          throw createBusyError();
        }

        return 'recovered';
      },
      {
        dbPath: '/tmp/opencode.db',
        maxBusyRetries: 2,
        busyRetryDelayMs: 5,
        sleep: sleepSpy,
      },
    );

    expect(result).toBe('recovered');
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(5);
  });

  it('throws actionable error when busy/locked retries are exhausted', async () => {
    const sleepSpy = vi.fn(async () => undefined);

    await expect(
      runWithBusyRetries(
        async () => {
          throw createBusyError();
        },
        {
          dbPath: '/tmp/opencode.db',
          maxBusyRetries: 2,
          busyRetryDelayMs: 5,
          sleep: sleepSpy,
        },
      ),
    ).rejects.toThrow(
      'OpenCode DB is busy/locked: /tmp/opencode.db. Retries exhausted after 3 attempt(s).',
    );

    expect(sleepSpy).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 5);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 10);
  });

  it('wraps non-busy sqlite errors with formatted context', async () => {
    const sleepSpy = vi.fn(async () => undefined);
    const sqliteError = Object.assign(new Error('syntax near FROM'), { code: 'SQLITE_ERROR' });

    await expect(
      runWithBusyRetries(
        async () => {
          throw sqliteError;
        },
        {
          dbPath: '/tmp/opencode.db',
          maxBusyRetries: 2,
          busyRetryDelayMs: 5,
          sleep: sleepSpy,
        },
      ),
    ).rejects.toThrow(
      'Could not read OpenCode DB at /tmp/opencode.db: SQLITE_ERROR: syntax near FROM',
    );

    expect(sleepSpy).not.toHaveBeenCalled();
  });
});
