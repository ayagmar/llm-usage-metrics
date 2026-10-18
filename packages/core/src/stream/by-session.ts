import { getEventSessionKey } from '../domain/usage-event.js';
import type { Stage } from './pipe.js';

/** One session's events, as `bySession` yields them. */
export type SessionGroup<E> = {
  source: string;
  sessionId: string;
  events: E[];
};

/**
 * Groups events by source and session. It buffers its whole input before yielding, since a
 * session's events can arrive at any point. Groups come out in the order their first event
 * arrived, and each group keeps its events in input order.
 */
export function bySession<E extends { source: string; sessionId: string }>(): Stage<
  E,
  SessionGroup<E>
> {
  return async function* (source) {
    const groups = new Map<string, SessionGroup<E>>();

    for await (const event of source) {
      const key = getEventSessionKey(event);
      const group = groups.get(key);

      if (group) {
        group.events.push(event);
      } else {
        groups.set(key, { source: event.source, sessionId: event.sessionId, events: [event] });
      }
    }

    yield* groups.values();
  };
}
