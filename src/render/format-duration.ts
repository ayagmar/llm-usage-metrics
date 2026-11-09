// Imports only constants and keeps no module state, so the share client can bundle it.

import { HOUR_MS, MINUTE_MS } from '../utils/time-constants.js';

export function formatDuration(durationMs: number): string {
  if (durationMs <= 0) {
    return '-';
  }

  const totalMinutes = Math.round(durationMs / MINUTE_MS);

  if (totalMinutes < 1) {
    return '<1m';
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Active time in whole hours, as the wrapped recap prints it: `12h`, `<1h`, `0h`. */
export function formatHours(activeMs: number): string {
  const hours = Math.round(activeMs / HOUR_MS);

  if (hours === 0) {
    return activeMs > 0 ? '<1h' : '0h';
  }

  return `${hours.toLocaleString('en-US')}h`;
}
