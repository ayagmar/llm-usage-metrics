// Imports nothing and keeps no module state, so the share client can bundle it.

export function formatDuration(durationMs: number): string {
  if (durationMs <= 0) {
    return '-';
  }

  const totalMinutes = Math.round(durationMs / 60_000);

  if (totalMinutes < 1) {
    return '<1m';
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

/** Active time in whole hours, as the wrapped recap prints it: `12h`, `<1h`, `0h`. */
export function formatHours(activeMs: number): string {
  const hours = Math.round(activeMs / 3_600_000);

  if (hours === 0) {
    return activeMs > 0 ? '<1h' : '0h';
  }

  return `${hours.toLocaleString('en-US')}h`;
}
