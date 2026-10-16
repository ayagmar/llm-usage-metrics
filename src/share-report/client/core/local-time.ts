/** A UTC instant read in the report's timezone. */
export type LocalDateHour = {
  dateKey: string;
  hour: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }

  return formatter;
}

/**
 * The local date and hour of an ISO timestamp in an explicit timezone, never the browser's;
 * undefined for an unparsable timestamp.
 */
export function toLocalDateHour(timestampIso: string, timezone: string): LocalDateHour | undefined {
  const timestampMs = Date.parse(timestampIso);

  if (Number.isNaN(timestampMs)) {
    return undefined;
  }

  const parts: Record<string, string> = {};

  for (const part of getFormatter(timezone).formatToParts(timestampMs)) {
    parts[part.type] = part.value;
  }

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}
