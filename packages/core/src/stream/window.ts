import type { Stage } from './pipe.js';

type Timestamped = { timestamp: string };

// Date.parse reads a time of day without an offset in the host's time zone.
const TIME_OF_DAY_PATTERN = /\d:\d/u;
// `String(date)` ends its offset with a zone name in parentheses.
const UTC_OFFSET_PATTERN = /(?:z|[+-]\d{2}:?\d{2}|gmt|utc)(?: \([^()]*\))?$/iu;
// The only date-only forms Date.parse reads as UTC: `2026`, `2026-06`, `2026-06-01`.
const ISO_DATE_PATTERN = /^(?:[+-]\d{6}|\d{4})(?:-\d{2}){0,2}$/u;

function toBoundMs(name: 'since' | 'until', bound: string | Date): number {
  const ms = typeof bound === 'string' ? Date.parse(bound) : bound.getTime();

  if (Number.isNaN(ms)) {
    throw new TypeError(`${name}: invalid date ${JSON.stringify(String(bound))}`);
  }

  if (typeof bound !== 'string' || UTC_OFFSET_PATTERN.test(bound.trim())) {
    return ms;
  }

  if (TIME_OF_DAY_PATTERN.test(bound)) {
    throw new TypeError(
      `${name}: ${JSON.stringify(bound)} has a time but no UTC offset, so its instant depends on the host time zone; add "Z" or an offset such as "+02:00"`,
    );
  }

  // Untrimmed: V8 reads `' 2026-06-01 '` as local midnight.
  if (!ISO_DATE_PATTERN.test(bound)) {
    throw new TypeError(
      `${name}: ${JSON.stringify(bound)} is a date in a non-ISO form, which means local midnight, so its instant depends on the host time zone; use an ISO date such as "2026-06-01" (midnight UTC) or a date-time with "Z" or an offset`,
    );
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
 * not strings, so years past 9999 (`+010000-...`) order correctly. An event whose
 * timestamp does not parse is dropped, by `until` as well.
 *
 * An invalid bound throws here, not on the first event, and so does a string bound whose
 * instant depends on the host time zone: a time of day without a UTC offset
 * (`'2026-06-01T10:00'`), or a date alone in a non-ISO form (`'2026/06/01'`,
 * `'June 1, 2026'`), which `Date.parse` reads as local midnight. An ISO date alone
 * (`'2026-06-01'`) is midnight UTC.
 */
export function since<E extends Timestamped>(bound: string | Date): Stage<E, E> {
  const boundMs = toBoundMs('since', bound);
  return keepWhere((timestampMs) => timestampMs >= boundMs);
}

/**
 * Keeps the events timestamped before `bound`, which is exclusive: `since(t)` and
 * `until(t)` split the events whose timestamp parses in two. An event whose timestamp does
 * not parse is dropped by both. Bounds are checked as in `since`.
 */
export function until<E extends Timestamped>(bound: string | Date): Stage<E, E> {
  const boundMs = toBoundMs('until', bound);
  return keepWhere((timestampMs) => timestampMs < boundMs);
}
