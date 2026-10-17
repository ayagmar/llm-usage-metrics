import { describe, expect, it } from 'vitest';

import { queryOpenCodeMessageRows } from '../../../src/sources/opencode/opencode-sqlite-query.js';

type FakeScenario = {
  tables?: string[];
  messageColumns?: string[];
  primaryRows?: Record<string, unknown>[];
  fallbackRows?: Record<string, unknown>[];
  primaryQueryErrors?: Error[];
  seenQueries?: string[];
};

type FakeDatabase = {
  prepare: (sql: string) => {
    all: () => Record<string, unknown>[];
    iterate?: () => IterableIterator<Record<string, unknown>>;
  };
};

function createFakeDatabase(scenario: FakeScenario): FakeDatabase {
  return {
    prepare(sql: string): {
      all: () => Record<string, unknown>[];
      iterate?: () => IterableIterator<Record<string, unknown>>;
    } {
      scenario.seenQueries?.push(sql);

      if (sql.includes('sqlite_master')) {
        const tables = scenario.tables ?? ['message'];
        return {
          all: () => tables.map((name) => ({ name })),
        };
      }

      if (/PRAGMA\s+table_info\(/iu.test(sql)) {
        const columns = scenario.messageColumns ?? ['id', 'time_created', 'session_id', 'data'];
        return {
          all: () => columns.map((name) => ({ name })),
        };
      }

      if (sql.includes('json_extract(')) {
        const queryError = scenario.primaryQueryErrors?.shift();

        if (queryError) {
          throw queryError;
        }

        return {
          all: () => scenario.primaryRows ?? [],
        };
      }

      return {
        all: () => scenario.fallbackRows ?? [],
      };
    },
  };
}

describe('opencode sqlite query', () => {
  it('builds and runs primary assistant query with role/type json_extract filter', () => {
    const seenQueries: string[] = [];
    const rows = queryOpenCodeMessageRows(
      createFakeDatabase({
        primaryRows: [{ row_id: 'msg-1', data_json: '{}' }],
        seenQueries,
      }),
    );

    expect([...rows]).toEqual([{ row_id: 'msg-1', data_json: '{}' }]);
    expect(seenQueries.some((query) => query.includes('$.role') && query.includes('$.type'))).toBe(
      true,
    );
  });

  it('falls back to non-json_extract query when primary query fails for json_extract availability', () => {
    const seenQueries: string[] = [];
    const rows = queryOpenCodeMessageRows(
      createFakeDatabase({
        primaryQueryErrors: [new Error('no such function: json_extract')],
        fallbackRows: [{ row_id: 'msg-fallback', data_json: '{}' }],
        seenQueries,
      }),
    );

    expect([...rows]).toEqual([{ row_id: 'msg-fallback', data_json: '{}' }]);
    expect(seenQueries.some((query) => query.includes('json_extract'))).toBe(true);
    expect(
      seenQueries.some(
        (query) => query.includes('FROM "message"') && !query.includes('WHERE lower(trim'),
      ),
    ).toBe(true);
  });

  it('falls back to non-json_extract query when primary query fails with malformed JSON', () => {
    const rows = queryOpenCodeMessageRows(
      createFakeDatabase({
        primaryQueryErrors: [new Error('malformed JSON')],
        fallbackRows: [{ row_id: 'msg-fallback-2', data_json: '{}' }],
      }),
    );

    expect([...rows]).toEqual([{ row_id: 'msg-fallback-2', data_json: '{}' }]);
  });

  it('falls back to non-json_extract query when json_valid is unavailable', () => {
    const rows = queryOpenCodeMessageRows(
      createFakeDatabase({
        primaryQueryErrors: [new Error('no such function: json_valid')],
        fallbackRows: [{ row_id: 'msg-fallback-3', data_json: '{}' }],
      }),
    );

    expect([...rows]).toEqual([{ row_id: 'msg-fallback-3', data_json: '{}' }]);
  });

  it('throws actionable schema drift error when message table is missing', () => {
    expect(() =>
      queryOpenCodeMessageRows(
        createFakeDatabase({
          tables: ['session', 'part'],
        }),
      ),
    ).toThrow('OpenCode schema drift: required "message" table not found.');
  });

  it('throws actionable schema drift error when message data column is missing', () => {
    expect(() =>
      queryOpenCodeMessageRows(
        createFakeDatabase({
          messageColumns: ['id', 'time_created', 'session_id'],
        }),
      ),
    ).toThrow('OpenCode schema drift: "message.data" column not found.');
  });

  it('throws actionable schema drift error when id/timestamp columns are missing', () => {
    expect(() =>
      queryOpenCodeMessageRows(
        createFakeDatabase({
          messageColumns: ['session_id', 'data'],
        }),
      ),
    ).toThrow('OpenCode schema drift: required message id/timestamp columns are unavailable.');
  });

  it('uses NULL session alias when session_id column is not available', () => {
    const seenQueries: string[] = [];

    queryOpenCodeMessageRows(
      createFakeDatabase({
        messageColumns: ['id', 'time_created', 'data'],
        primaryRows: [],
        seenQueries,
      }),
    );

    expect(seenQueries.some((query) => query.includes('NULL AS row_session_id'))).toBe(true);
  });

  it('streams result rows via iterate() when sqlite statements support it', () => {
    const database = {
      prepare(sql: string): {
        all: () => Record<string, unknown>[];
        iterate?: () => IterableIterator<Record<string, unknown>>;
      } {
        if (sql.includes('sqlite_master')) {
          return {
            all: () => [{ name: 'message' }],
          };
        }

        if (/PRAGMA\s+table_info\(/iu.test(sql)) {
          return {
            all: () => [
              { name: 'id' },
              { name: 'time_created' },
              { name: 'session_id' },
              { name: 'data' },
            ],
          };
        }

        return {
          all: () => {
            throw new Error('all() should not be used when iterate() is available');
          },
          iterate: function* iterateRows(): IterableIterator<Record<string, unknown>> {
            yield { row_id: 'iter-1', data_json: '{}' };
            yield { row_id: 'iter-2', data_json: '{}' };
          },
        };
      },
    };

    const rows = [...queryOpenCodeMessageRows(database)];
    expect([...rows]).toEqual([
      { row_id: 'iter-1', data_json: '{}' },
      { row_id: 'iter-2', data_json: '{}' },
    ]);
  });

  it('falls back when iterate() throws json-function error on first next()', () => {
    const seenQueries: string[] = [];

    const database = {
      prepare(sql: string): {
        all: () => Record<string, unknown>[];
        iterate?: () => IterableIterator<Record<string, unknown>>;
      } {
        seenQueries.push(sql);

        if (sql.includes('sqlite_master')) {
          return {
            all: () => [{ name: 'message' }],
          };
        }

        if (/PRAGMA\s+table_info\(/iu.test(sql)) {
          return {
            all: () => [
              { name: 'id' },
              { name: 'time_created' },
              { name: 'session_id' },
              { name: 'data' },
            ],
          };
        }

        if (sql.includes('json_extract(')) {
          return {
            all: () => {
              throw new Error('all() should not be used when iterate() is available');
            },
            iterate: (): IterableIterator<Record<string, unknown>> => ({
              [Symbol.iterator]() {
                return this;
              },
              next(): IteratorResult<Record<string, unknown>> {
                throw new Error('no such function: json_valid');
              },
              return(): IteratorResult<Record<string, unknown>> {
                return { done: true, value: undefined };
              },
              throw(error: unknown): IteratorResult<Record<string, unknown>> {
                throw error;
              },
            }),
          };
        }

        return {
          all: () => [{ row_id: 'iter-fallback', data_json: '{}' }],
        };
      },
    };

    const rows = [...queryOpenCodeMessageRows(database)];

    expect([...rows]).toEqual([{ row_id: 'iter-fallback', data_json: '{}' }]);
    expect(seenQueries.some((query) => query.includes('json_extract('))).toBe(true);
    expect(
      seenQueries.some(
        (query) => query.includes('FROM "message"') && !query.includes('json_extract('),
      ),
    ).toBe(true);
  });
});
