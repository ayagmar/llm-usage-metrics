import type {
  SourceParseFileDiagnostics,
  SourceReadOptions,
  UsageEvent,
} from '@ayagmar/agent-sessions';

type Awaitable<T> = T | Promise<T>;

/** A fake adapter `read` that yields the events `parse` returns for a file. */
export function readFrom<Event extends UsageEvent>(
  parse: (filePath: string) => Awaitable<readonly Event[]>,
): (filePath: string) => AsyncGenerator<Event> {
  return async function* (filePath) {
    yield* await parse(filePath);
  };
}

/** A fake adapter `read` that also adds the skipped rows `parse` returns to the sink. */
export function readWithDiagnostics<Event extends UsageEvent>(
  parse: (filePath: string) => Awaitable<SourceParseFileDiagnostics<Event>>,
): (filePath: string, options?: SourceReadOptions) => AsyncGenerator<Event> {
  return async function* (filePath, options) {
    const result = await parse(filePath);
    const diagnostics = options?.diagnostics;

    if (diagnostics) {
      diagnostics.skippedRows += result.skippedRows;

      for (const { reason, count } of result.skippedRowReasons ?? []) {
        diagnostics.skippedRowReasons.set(
          reason,
          (diagnostics.skippedRowReasons.get(reason) ?? 0) + count,
        );
      }
    }

    yield* result.events;
  };
}
