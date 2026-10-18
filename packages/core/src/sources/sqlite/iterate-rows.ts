export type SqliteRow = Record<string, unknown>;

export type SqliteRowStatement = {
  all: (...anonymousParameters: unknown[]) => SqliteRow[];
  iterate?: (...anonymousParameters: unknown[]) => IterableIterator<SqliteRow>;
};

/**
 * Steps a statement one row at a time, pulling the first row now so a query that fails
 * when it starts (a busy database, a missing JSON function) throws here rather than in
 * the caller's loop. Returning the iterator returns the statement's iterator. Without
 * `iterate` (Bun), it reads every row with `all()`.
 */
export function iterateRows(
  statement: SqliteRowStatement,
  ...anonymousParameters: unknown[]
): IterableIterator<SqliteRow> {
  if (!statement.iterate) {
    return statement.all(...anonymousParameters)[Symbol.iterator]();
  }

  const iterator = statement.iterate(...anonymousParameters);
  let firstResult: IteratorResult<SqliteRow> | undefined = iterator.next();

  return {
    next(): IteratorResult<SqliteRow> {
      if (firstResult) {
        const result = firstResult;
        firstResult = undefined;
        return result;
      }

      return iterator.next();
    },
    return(value?: unknown): IteratorResult<SqliteRow> {
      firstResult = undefined;
      return iterator.return?.(value) ?? { done: true, value: undefined };
    },
    [Symbol.iterator](): IterableIterator<SqliteRow> {
      return this;
    },
  };
}
