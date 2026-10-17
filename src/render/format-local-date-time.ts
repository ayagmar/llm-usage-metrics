const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/** `2026-06-15 09:05`: the timestamp's wall-clock minute in `timezone`. */
export function formatLocalDateTime(isoTimestamp: string, timezone: string): string {
  let formatter = dateTimeFormatters.get(timezone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    dateTimeFormatters.set(timezone, formatter);
  }

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(isoTimestamp)).map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** `2026-06-15 09:00-14:00`, or `2026-06-15 21:00-2026-06-16 02:00` across midnight. */
export function formatLocalDateTimeSpan(
  startTimestamp: string,
  endTimestamp: string,
  timezone: string,
): string {
  const start = formatLocalDateTime(startTimestamp, timezone);
  const end = formatLocalDateTime(endTimestamp, timezone);
  const sameDay = start.slice(0, 10) === end.slice(0, 10);

  return `${start}-${sameDay ? end.slice(11) : end}`;
}
