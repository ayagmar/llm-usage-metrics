import { describe, expect, it, vi } from 'vitest';

import { AntigravitySourceAdapter } from '../../src/sources/antigravity/antigravity-source-adapter.js';
import { GooseSourceAdapter } from '../../src/sources/goose/goose-source-adapter.js';
import { OpenCodeSourceAdapter } from '../../src/sources/opencode/opencode-source-adapter.js';
import { runWithBusyRetries, toSqliteDbReadError } from '../../src/sources/sqlite/retry-policy.js';
import {
  formatSqliteError,
  isBusyOrLockedSqliteError,
} from '../../src/sources/sqlite/sqlite-errors.js';

function createBusyError(message = 'database is locked'): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = 'SQLITE_BUSY';
  return error;
}

describe('sqlite error helpers', () => {
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

describe('sqlite retry policy', () => {
  it('returns operation result without sleeping when first attempt succeeds', async () => {
    const sleepSpy = vi.fn(async () => undefined);
    const result = await runWithBusyRetries(async () => 'ok', {
      source: 'OpenCode',
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
        source: 'OpenCode',
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
          source: 'OpenCode',
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
          source: 'OpenCode',
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

  it('names the source in both message templates', () => {
    const busyError = createBusyError();
    const ioError = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });

    const busy = toSqliteDbReadError(busyError, 'Goose', '/tmp/goose.db', 3);
    const io = toSqliteDbReadError(ioError, 'Antigravity', '/tmp/a.db', 1);

    expect(busy.message).toBe(
      'Goose DB is busy/locked: /tmp/goose.db. Retries exhausted after 3 attempt(s). Close active Goose processes and retry.',
    );
    expect(busy.cause).toBe(busyError);
    expect(io.message).toBe(
      'Could not read Antigravity DB at /tmp/a.db: SQLITE_IOERR: disk I/O error',
    );
    expect(io.cause).toBe(ioError);
  });
});

describe('sqlite adapter maxBusyRetries', () => {
  const adapters = [
    ['OpenCode', (maxBusyRetries?: number) => new OpenCodeSourceAdapter({ maxBusyRetries })],
    ['Goose', (maxBusyRetries?: number) => new GooseSourceAdapter({ maxBusyRetries })],
    ['Antigravity', (maxBusyRetries?: number) => new AntigravitySourceAdapter({ maxBusyRetries })],
  ] as const;

  it.each(adapters)('%s rejects a value that is not a non-negative integer', (name, create) => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => create(value)).toThrow(
        `${name} maxBusyRetries must be a non-negative integer (0 disables retries), got ${String(value)}`,
      );
    }

    for (const value of [undefined, 0, 3]) {
      expect(() => create(value)).not.toThrow();
    }
  });
});
