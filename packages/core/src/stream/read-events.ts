import type { SessionEvent } from '../domain/session-event.js';
import { getDeclaredKinds, resolveReadKinds } from '../sources/session-event-helpers.js';
import type { ReadEventsOptions, SourceAdapter } from '../sources/source-adapter.js';

/**
 * Reads a file's events of the requested kinds. An adapter without `readEvents` yields
 * its `read` events as usage records, without ids, raw provider or `raw`, and nothing of
 * any other kind. A kind the adapter does not declare yields nothing.
 */
export async function* readEvents(
  adapter: SourceAdapter,
  filePath: string,
  options: ReadEventsOptions = {},
): AsyncGenerator<SessionEvent> {
  if (adapter.readEvents) {
    yield* adapter.readEvents(filePath, options);
    return;
  }

  if (!resolveReadKinds(options.kinds, getDeclaredKinds(adapter)).has('usage')) {
    return;
  }

  for await (const event of adapter.read(filePath, { diagnostics: options.diagnostics })) {
    yield { kind: 'usage', ...event };
  }
}
