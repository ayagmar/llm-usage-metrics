import { getDateKeyPeriod, getDateKeyRange, getPeriodKeyRange } from '../../../utils/date-key.js';
import type { ShareGranularity } from '../../types.js';
import type { ShareReport } from './decode.js';
import type { ShareFilters } from './filters.js';

/** The first and last local date the view covers, both inclusive; undefined when it is empty. */
export type ShareDateSpan = { first: string; last: string };

/**
 * The dates the view spans: the filter range, with open ends taken from the window and then
 * from the data, so a chart axis has fixed ends whatever cells the filters keep.
 */
export function getViewDateSpan(
  report: ShareReport,
  filters: ShareFilters,
): ShareDateSpan | undefined {
  const { window } = report.data.meta;
  const dataDates = report.periods.map((period) => period.dateKey).sort();
  const first = filters.since ?? window.since ?? dataDates.at(0);
  const last = filters.until ?? window.until ?? dataDates.at(-1);

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
