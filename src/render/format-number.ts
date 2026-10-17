/** Lowercase compact numbers (`1.2k`, `3.4M`) for the statusline and summary. */
export function formatStatuslineCompact(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

const intFmt = new Intl.NumberFormat('en-US');
const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatInteger(n: number): string {
  return intFmt.format(n);
}

export { pluralize } from '@ayagmar/agent-sessions/internal';

export function formatUsd(n: number | undefined): string {
  return n === undefined ? '-' : usdFmt.format(n);
}

export function formatApproxUsd(
  value: number | undefined,
  approximate: boolean | undefined,
): string {
  const formatted = formatUsd(value);
  return value !== undefined && approximate ? `~${formatted}` : formatted;
}

/** One-decimal percent of a 0..1 share, or `-` when the share is unknown. */
export function formatSharePercent(share: number | null): string {
  return share === null ? '-' : `${(share * 100).toFixed(1)}%`;
}
