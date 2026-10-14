import type { UsageEvent } from '../domain/usage-event.js';
import { createReadDiagnostics, toParseDiagnostics } from '../sources/parse-diagnostics.js';
import type {
  SourceAdapter,
  SourceParseFileDiagnostics,
  SourceReadOptions,
} from '../sources/source-adapter.js';

export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of source) {
    items.push(item);
  }

  return items;
}

/**
 * Reads a whole file into today's diagnostics shape; a read that throws yields nothing.
 * An adapter without `read` returns its legacy result as it is.
 */
export async function collectFile<Event extends UsageEvent>(
  adapter: SourceAdapter<Event>,
  filePath: string,
): Promise<SourceParseFileDiagnostics<Event>> {
  if (!adapter.read) {
    return adapter.parseFileWithDiagnostics
      ? adapter.parseFileWithDiagnostics(filePath)
      : { events: await adapter.parseFile(filePath), skippedRows: 0, skippedRowReasons: [] };
  }

  const diagnostics = createReadDiagnostics();
  const events = await collect(adapter.read(filePath, { diagnostics }));

  return toParseDiagnostics(events, diagnostics.skippedRows, diagnostics.skippedRowReasons);
}

/**
 * Reads through `read`, or through the legacy parse methods for an adapter without one,
 * adding their counts to `options.diagnostics`.
 */
export async function* readAdapterFile<Event extends UsageEvent>(
  adapter: SourceAdapter<Event>,
  filePath: string,
  options: SourceReadOptions = {},
): AsyncGenerator<Event, void, undefined> {
  if (adapter.read) {
    yield* adapter.read(filePath, options);
    return;
  }

  if (!adapter.parseFileWithDiagnostics) {
    yield* await adapter.parseFile(filePath);
    return;
  }

  const result = await adapter.parseFileWithDiagnostics(filePath);
  const { diagnostics } = options;

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
}
