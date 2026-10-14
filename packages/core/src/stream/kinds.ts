import type { EventKind, SessionEvent } from '../domain/session-event.js';
import type { Stage } from './pipe.js';

/** Keeps the events of the `wanted` kinds, narrowing the stream's type to them. */
export function kinds<K extends EventKind>(
  ...wanted: K[]
): Stage<SessionEvent, Extract<SessionEvent, { kind: K }>> {
  const wantedKinds = new Set<EventKind>(wanted);
  const isWanted = (event: SessionEvent): event is Extract<SessionEvent, { kind: K }> =>
    wantedKinds.has(event.kind);

  return async function* (source) {
    for await (const event of source) {
      if (isWanted(event)) {
        yield event;
      }
    }
  };
}
