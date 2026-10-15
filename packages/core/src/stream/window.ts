import type { Stage } from './pipe.js';

type Timestamped = { timestamp: string };

function toBoundMs(name: 'since' | 'until', bound: string | Date): number {
  const ms = typeof bound === 'string' ? Date.parse(bound) : bound.getTime();

  if (Number.isNaN(ms)) {
    throw new TypeError(`${name}: invalid date ${JSON.stringify(String(bound))}`);
  }

  return ms;
}

function keepWhere<E extends Timestamped>(keep: (timestampMs: number) => boolean): Stage<E, E> {
  return async function* (source) {
    for await (const event of source) {
      if (keep(Date.parse(event.timestamp))) {
        yield event;
      }
    }
  };
}

/**
 * Keeps the events timestamped at or after `bound`. Timestamps are compared as instants,
 * not strings, so years past 9999 (`+010000-...`) order correctly. An invalid bound throws
 * here, not on the first event.
 */
export function since<E extends Timestamped>(bound: string | Date): Stage<E, E> {
  const boundMs = toBoundMs('since', bound);
  return keepWhere((timestampMs) => timestampMs >= boundMs);
}

/**
 * Keeps the events timestamped before `bound`, which is exclusive: `since(t)` and
 * `until(t)` split a stream in two. An invalid bound throws here, not on the first event.
 */
export function until<E extends Timestamped>(bound: string | Date): Stage<E, E> {
  const boundMs = toBoundMs('until', bound);
  return keepWhere((timestampMs) => timestampMs < boundMs);
}
