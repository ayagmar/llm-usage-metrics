type DateTimePrecision = 'minute' | 'second';

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function getDateTimeFormatter(timezone: string, precision: DateTimePrecision) {
  const key = `${precision}\0${timezone}`;
  let formatter = dateTimeFormatters.get(key);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      ...(precision === 'second' ? { second: '2-digit' } : {}),
    });
    dateTimeFormatters.set(key, formatter);
  }

  return formatter;
}

/** `2026-06-15 09:05` (or `09:05:30` to the second): the wall-clock time in `timezone`. */
export function formatLocalDateTime(
  isoTimestamp: string,
  timezone: string,
  precision: DateTimePrecision = 'minute',
): string {
  const parts = Object.fromEntries(
    getDateTimeFormatter(timezone, precision)
      .formatToParts(new Date(isoTimestamp))
      .map((part) => [part.type, part.value]),
  );
  const time = `${parts.hour}:${parts.minute}`;

  return `${parts.year}-${parts.month}-${parts.day} ${precision === 'second' ? `${time}:${parts.second}` : time}`;
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
