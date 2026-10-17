import { getDateKeyPeriod, getDateKeyRange, getPeriodKeyRange } from '../../../utils/date-key.js';
import type { ShareGranularity } from '../../types.js';
import type { ShareReport } from './decode.js';
import type { ShareFilters } from './filters.js';
import { toLocalDateHour } from './local-time.js';

/** The first and last local date the view covers, both inclusive; undefined when it is empty. */
export type ShareDateSpan = { first: string; last: string };

/**
 * The last date the file covers: the window's end, or the local date it was generated on when
 * the window is open or ends later (wrapped's 31 Dec), so no view runs into the future. Without
 * a readable generation time, the window's end, else the newest date with data.
 */
export function getWindowEnd(report: ShareReport): string | undefined {
  const { window, generatedAt, timezone } = report.data.meta;
  const generated = toLocalDateHour(generatedAt, timezone)?.dateKey;

  if (generated === undefined) {
    return (
      window.until ??
      report.periods.reduce<string | undefined>(
        (last, period) => (last === undefined || period.dateKey > last ? period.dateKey : last),
        undefined,
      )
    );
  }

  return window.until !== null && window.until < generated ? window.until : generated;
}

/** A range's end as the page shows it: an open end or one past `getWindowEnd` is that date. */
export function resolveUntil(report: ShareReport, until: string | null): string | null {
  const end = getWindowEnd(report);
  return end !== undefined && (until === null || until > end) ? end : until;
}

/**
 * A range's start as the page shows it: an open start is the window's, else the first date with
 * data (a file made with `--all` has no window start).
 */
export function resolveSince(report: ShareReport, since: string | null): string | undefined {
  return (
    since ??
    report.data.meta.window.since ??
    report.periods.reduce<string | undefined>(
      (first, period) => (first === undefined || period.dateKey < first ? period.dateKey : first),
      undefined,
    )
  );
}

/**
 * The dates the view spans: the filter range, with an open start taken from the window and then
 * from the data, and the end resolved by `resolveUntil`, so a chart axis has fixed ends whatever
 * cells the filters keep and never runs past the generation date.
 */
export function getViewDateSpan(
  report: ShareReport,
  filters: ShareFilters,
): ShareDateSpan | undefined {
  const first = resolveSince(report, filters.since);
  const last = resolveUntil(report, filters.until) ?? undefined;

  return first !== undefined && last !== undefined && first <= last ? { first, last } : undefined;
}

/**
 * Every period key from the span's first to last date at a granularity, including periods
 * without data. Hour keys start at `meta.hourlyFrom`; a DST day still lists 24 hours, since
 * the cube keeps one key per wall-clock hour (a skipped hour simply has no data).
 */
export function getPeriodAxis(
  report: ShareReport,
  span: ShareDateSpan,
  granularity: ShareGranularity,
): string[] {
  if (granularity !== 'hour') {
    return getPeriodKeyRange(
      getDateKeyPeriod(span.first, granularity),
      getDateKeyPeriod(span.last, granularity),
      granularity,
    );
  }

  const { hourlyFrom } = report.data.meta;
  const first = hourlyFrom !== null && hourlyFrom > span.first ? hourlyFrom : span.first;

  return getDateKeyRange(first, span.last).flatMap((dateKey) =>
    Array.from({ length: 24 }, (_, hour) => `${dateKey} ${String(hour).padStart(2, '0')}:00`),
  );
}
