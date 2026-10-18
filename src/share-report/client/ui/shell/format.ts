// How the page writes percentages, costs and dates. Counts, token amounts, durations and times
// come from the terminal's own formatters in src/render and packages/core, so the page and the
// CLI print the same text. One fixed locale (en-US), and every date in the report's timezone.

import { MONTH_LABELS } from '../../../../render/month-labels.js';
import { formatLocalDateTime } from '../../../../render/format-local-date-time.js';
import { parseDateKey } from '../../../../utils/date-key.js';
import { pluralize } from '../../../../../packages/core/src/utils/pluralize.js';
import { formatUsdOrNone, NO_VALUE, type ShareCostValue } from '../../core/index.js';

let percentFormatter: Intl.NumberFormat | undefined;

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

/** A cost cell: its text and, when some events had no price, why it is a lower bound. */
export type CostText = { text: string; note?: string };

function describeIncomplete(count: number): string {
  return `${pluralize(count, 'event')} had no price, so this is a lower bound`;
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

/** `2026-10-26 23:07` in the report's timezone; {@link NO_VALUE} for an unreadable time. */
export function formatTimeOrNone(timestampIso: string, timezone: string): string {
  return Number.isNaN(Date.parse(timestampIso))
    ? NO_VALUE
    : formatLocalDateTime(timestampIso, timezone);
}
