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
