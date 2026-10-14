import type { UsageEvent } from '../domain/usage-event.js';
import { createReadDiagnostics, toParseDiagnostics } from '../sources/parse-diagnostics.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../sources/source-adapter.js';

export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];

  for await (const item of source) {
    items.push(item);
  }

  return items;
}

/** Reads a whole file into the sorted diagnostics shape; a read that throws yields nothing. */
export async function collectFile<Event extends UsageEvent>(
  adapter: SourceAdapter<Event>,
  filePath: string,
): Promise<SourceParseFileDiagnostics<Event>> {
  const diagnostics = createReadDiagnostics();
  const events = await collect(adapter.read(filePath, { diagnostics }));

  return toParseDiagnostics(events, diagnostics.skippedRows, diagnostics.skippedRowReasons);
}
