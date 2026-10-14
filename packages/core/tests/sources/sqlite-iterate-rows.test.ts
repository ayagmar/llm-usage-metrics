import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { iterateRows, type SqliteRow } from '../../src/sources/sqlite/iterate-rows.js';
import { canCountOpenFds, countOpenFds, waitForOpenFdCount } from '../helpers/open-fds.js';
import {
  canBeginExclusive,
  loadDatabaseSync,
  readJournalMode,
  requireDatabaseSync,
} from '../helpers/sqlite.js';

const DatabaseSync = loadDatabaseSync();
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function createStatementIterator(rows: SqliteRow[]) {
  let index = 0;
  const next = vi.fn((): IteratorResult<SqliteRow> => {
    if (index >= rows.length) {
      return { done: true, value: undefined };
    }

    index += 1;
    return { done: false, value: rows[index - 1] };
  });
  const returnIterator = vi.fn((): IteratorResult<SqliteRow> => {
    index = rows.length;
    return { done: true, value: undefined };
  });
  const iterator: IterableIterator<SqliteRow> = {
    next,
    return: returnIterator,
    [Symbol.iterator]() {
      return this;
    },
  };

  return { iterator, next, returnIterator };
}

async function createDeleteJournalDb(rowCount: number): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sqlite-iterate-rows-'));
  tempDirs.push(root);
  const dbPath = path.join(root, 'rows.db');
  const database = new (requireDatabaseSync())(dbPath);

  try {
    database.exec('PRAGMA journal_mode = DELETE');
    database.exec('CREATE TABLE item (id INTEGER PRIMARY KEY)');

    for (let id = 1; id <= rowCount; id += 1) {
      database.prepare('INSERT INTO item (id) VALUES (?)').run(id);
    }
  } finally {
    database.close();
  }

  expect(readJournalMode(dbPath)).toBe('delete');
  return dbPath;
}

describe('iterateRows', () => {
  it('pulls the first row before returning, so a failing query throws at the call', () => {
    const queryError = new Error('database is locked');
    const statement = {
      all: () => [],
      iterate: (): IterableIterator<SqliteRow> => ({
        next(): IteratorResult<SqliteRow> {
          throw queryError;
        },
        [Symbol.iterator]() {
          return this;
        },
      }),
    };

    expect(() => iterateRows(statement)).toThrow(queryError);
  });

  it('yields every row in statement order, the eagerly pulled one first', () => {
    const statement = createStatementIterator([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const rows = iterateRows({ all: () => [], iterate: () => statement.iterator });

    expect(statement.next).toHaveBeenCalledTimes(1);
    expect([...rows]).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('passes parameters to the statement', () => {
    const iterate = vi.fn(() => createStatementIterator([{ id: 2 }]).iterator);
    const all = vi.fn(() => [{ id: 2 }]);

    expect([...iterateRows({ all, iterate }, 2, 'x')]).toEqual([{ id: 2 }]);
    expect(iterate).toHaveBeenCalledWith(2, 'x');
    expect([...iterateRows({ all }, 3)]).toEqual([{ id: 2 }]);
    expect(all).toHaveBeenCalledWith(3);
  });

  it('returns the statement iterator, also before the first row was consumed', () => {
    const statement = createStatementIterator([{ id: 1 }, { id: 2 }]);
    const rows = iterateRows({ all: () => [], iterate: () => statement.iterator });

    expect(rows.return?.()).toEqual({ done: true, value: undefined });
    expect(statement.returnIterator).toHaveBeenCalledTimes(1);
    expect(rows.next()).toEqual({ done: true, value: undefined });
  });

  it('returns the statement iterator when a loop over the rows breaks', () => {
    const statement = createStatementIterator([{ id: 1 }, { id: 2 }, { id: 3 }]);

    for (const row of iterateRows({ all: () => [], iterate: () => statement.iterator })) {
      expect(row).toEqual({ id: 1 });
      break;
    }

    expect(statement.returnIterator).toHaveBeenCalledTimes(1);
  });

  it('reads every row with all() when the statement has no iterate (Bun)', () => {
    expect([...iterateRows({ all: () => [{ id: 1 }, { id: 2 }] })]).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it.runIf(DatabaseSync && canCountOpenFds)(
    'frees the database for a writer once the rows are returned and the database closed',
    async () => {
      const dbPath = await createDeleteJournalDb(3);
      const before = countOpenFds();
      const database = new (requireDatabaseSync())(dbPath);

      for (const row of iterateRows(database.prepare('SELECT id FROM item ORDER BY id'))) {
        expect(row).toEqual({ id: 1 });
        break;
      }

      database.close();

      await waitForOpenFdCount(before);
      expect(canBeginExclusive(dbPath)).toBe(true);
    },
  );

  it.runIf(DatabaseSync && canCountOpenFds)(
    'fails both checks on a planted leak: rows iterated, never returned or closed',
    async () => {
      const dbPath = await createDeleteJournalDb(3);
      const before = countOpenFds();
      const database = new (requireDatabaseSync())(dbPath);
      const leaked = database.prepare('SELECT id FROM item ORDER BY id').iterate();

      try {
        expect(leaked.next()).toEqual({ done: false, value: { id: 1 } });
        await expect(waitForOpenFdCount(before, 100)).rejects.toThrow(
          `Expected ${before} open fds`,
        );
        expect(canBeginExclusive(dbPath)).toBe(false);
      } finally {
        leaked.return?.();
        database.close();
      }
    },
  );
});
