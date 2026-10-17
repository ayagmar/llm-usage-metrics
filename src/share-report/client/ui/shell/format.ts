// How the page writes numbers, durations and dates. One fixed locale (en-US) so a file reads
// the same on every machine, and every date in the report's timezone, never the browser's.
// Formatters are created on first use: the module does no work when it loads.

import { MONTH_LABELS } from '../../../../render/month-labels.js';
import { parseDateKey } from '../../../../utils/date-key.js';
import { formatUsdOrNone, NO_VALUE, type ShareCostValue } from '../../core/index.js';

let countFormatter: Intl.NumberFormat | undefined;
let compactFormatter: Intl.NumberFormat | undefined;
let percentFormatter: Intl.NumberFormat | undefined;
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/** `24,300` */
export function formatCount(value: number): string {
  countFormatter ??= new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  return countFormatter.format(value);
}

/** `24.3K`: three significant digits, as the terminal tables write them. */
export function formatCompact(value: number): string {
  compactFormatter ??= new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumSignificantDigits: 3,
  });
  return compactFormatter.format(value);
}

/** `67.4%`, or {@link NO_VALUE} without a denominator. */
export function formatPercent(rate: number | null): string {
  if (rate === null) {
    return NO_VALUE;
  }

  percentFormatter ??= new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return percentFormatter.format(rate);
}

const MINUTE_MS = 60_000;

/** `3h 05m`, `12m`, `<1m` for a moment of activity, `0m` for none. */
export function formatDuration(ms: number): string {
  if (ms <= 0) {
    return '0m';
  }

  const minutes = Math.floor(ms / MINUTE_MS);

  if (minutes === 0) {
    return '<1m';
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return hours === 0 ? `${rest}m` : `${hours}h ${String(rest).padStart(2, '0')}m`;
}

/** A cost cell: its text and, when some events had no price, why it is a lower bound. */
export type CostText = { text: string; note?: string };

function describeIncomplete(count: number): string {
  return `${formatCount(count)} event${count === 1 ? '' : 's'} had no price, so this is a lower bound`;
}

/**
 * `$1.23`; `~$1.23` when some events had no price (as the terminal marks it); {@link NO_VALUE}
 * when no event had one; `n/a` when pricing failed for the mode.
 */
export function formatCost(value: ShareCostValue): CostText {
  switch (value.kind) {
    case 'none':
      return { text: NO_VALUE, note: 'This file holds no cost' };
    case 'unavailable':
      return { text: 'n/a', note: 'Prices could not be loaded for this cost mode' };
    case 'value':
      if (value.costUsd === null) {
        return value.incompleteEvents > 0
          ? { text: NO_VALUE, note: describeIncomplete(value.incompleteEvents) }
          : { text: NO_VALUE };
      }

      return value.incompleteEvents > 0
        ? {
            text: `~${formatUsdOrNone(value.costUsd)}`,
            note: describeIncomplete(value.incompleteEvents),
          }
        : { text: formatUsdOrNone(value.costUsd) };
  }
}

/** `20 Oct 2026` from `2026-10-20`; the key itself when it is not a date. */
export function formatDay(dateKey: string): string {
  const parts = parseDateKey(dateKey);

  return parts ? `${parts.day} ${MONTH_LABELS[parts.month - 1]} ${parts.year}` : dateKey;
}

/** `20 Oct 2026 – 26 Oct 2026`, one date when both ends match, open ends spelled out. */
export function formatDateRange(since: string | null, until: string | null): string {
  if (since === null && until === null) {
    return 'All dates';
  }

  if (since === null) {
    return `Up to ${formatDay(until ?? '')}`;
  }

  if (until === null) {
    return `From ${formatDay(since)}`;
  }

  return since === until ? formatDay(since) : `${formatDay(since)} – ${formatDay(until)}`;
}

function getDateTimeFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = dateTimeFormatters.get(timezone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    dateTimeFormatters.set(timezone, formatter);
  }

  return formatter;
}

/** `2026-10-26 23:07` in the report's timezone; {@link NO_VALUE} for an unreadable time. */
export function formatTimestamp(timestampIso: string, timezone: string): string {
  const timestampMs = Date.parse(timestampIso);

  if (Number.isNaN(timestampMs)) {
    return NO_VALUE;
  }

  const parts: Record<string, string> = {};

  for (const part of getDateTimeFormatter(timezone).formatToParts(timestampMs)) {
    parts[part.type] = part.value;
  }

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** `1 session`, `3 sessions` */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}
