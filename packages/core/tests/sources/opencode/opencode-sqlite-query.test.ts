import { describe, expect, it } from 'vitest';

import { queryOpenCodeMessageRows } from '../../../src/sources/opencode/opencode-sqlite-query.js';

type FakeScenario = {
  tables?: string[];
  messageColumns?: string[];
  primaryRows?: Record<string, unknown>[];
  v2Rows?: Record<string, unknown>[];
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

      if (sql.includes('session_message')) {
        return {
          all: () => scenario.v2Rows ?? [],
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
    ).toThrow(
      'OpenCode schema drift: no "message" table (V1) or "session_message" and "session_v2" tables (V2) found.',
    );
  });

  it('reads V2 rows from session_message joined to session_v2 when there is no message table', () => {
    const seenQueries: string[] = [];
    const rows = queryOpenCodeMessageRows(
      createFakeDatabase({
        tables: ['session_v2', 'session_message', 'event'],
        v2Rows: [{ row_id: 'step-1', row_type: 'assistant', data_json: '{}' }],
        seenQueries,
      }),
    );

    expect([...rows]).toEqual([{ row_id: 'step-1', row_type: 'assistant', data_json: '{}' }]);
    const v2Query = seenQueries.find((query) => query.includes('FROM "session_message"'));
    expect(v2Query).toContain('LEFT JOIN "session_v2"');
    expect(v2Query).not.toContain('NOT IN');
    expect(seenQueries.some((query) => query.includes('PRAGMA'))).toBe(false);
  });

  it('reads V1 rows, then V2 rows not already in message, from a database migrated in place', () => {
    const seenQueries: string[] = [];
    const rows = queryOpenCodeMessageRows(
      createFakeDatabase({
        tables: ['session', 'message', 'part', 'session_v2', 'session_message'],
        primaryRows: [{ row_id: 'v1-message' }],
        v2Rows: [{ row_id: 'v2-step', row_type: 'assistant' }],
        seenQueries,
      }),
    );

    expect([...rows].map((row) => row.row_id)).toEqual(['v1-message', 'v2-step']);
    expect(seenQueries.find((query) => query.includes('FROM "session_message"'))).toContain(
      'NOT IN (SELECT "id" FROM "message")',
    );
  });

  it('throws schema drift for session_message without session_v2', () => {
    expect(() =>
      queryOpenCodeMessageRows(
        createFakeDatabase({ tables: ['project', 'session', 'session_message'] }),
      ),
    ).toThrow('OpenCode schema drift');
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
