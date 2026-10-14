import type { UsageEvent } from '../../src/domain/usage-event.js';

/** A fake adapter `read` that yields the events `parse` returns for a file. */
export function readFrom<Event extends UsageEvent>(
  parse: (filePath: string) => readonly Event[] | Promise<readonly Event[]>,
): (filePath: string) => AsyncGenerator<Event> {
  return async function* (filePath) {
    yield* await parse(filePath);
  };
}
