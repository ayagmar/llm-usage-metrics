import {
  parseSelectedAdapters,
  type ParsedAdaptersResult,
} from '../../src/cli/build-usage-data-parsing.js';
import { closeEventStore, openEventStore } from '../../src/persistence/event-store.js';
import type { SourceAdapter } from '@ayagmar/agent-sessions';

type ParseOptions = NonNullable<Parameters<typeof parseSelectedAdapters>[2]>;

/** One report's parse over a real store: opened for it and closed after, as the dataset does. */
export async function parseWithEventStore(
  adapters: SourceAdapter[],
  maxParallelFileParsing: number,
  { eventStorePath, ...options }: Omit<ParseOptions, 'store'> & { eventStorePath: string },
): Promise<ParsedAdaptersResult> {
  const store = await openEventStore(eventStorePath);

  try {
    return await parseSelectedAdapters(adapters, maxParallelFileParsing, { ...options, store });
  } finally {
    closeEventStore(store);
  }
}
