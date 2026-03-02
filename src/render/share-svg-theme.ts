/**
 * Shared dark-theme design tokens and SVG utilities for share images.
 */

export const shareTheme = {
  bg: '#0d1117',
  cardBg: '#161b22',
  cardBorder: '#30363d',
  textPrimary: '#e6edf3',
  textSecondary: '#8b949e',
  textMuted: '#484f58',
  gridLine: '#21262d',
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  mono: "ui-monospace, 'SF Mono', 'Fira Code', monospace",
} as const;

const knownSourceColors: Readonly<Record<string, string>> = {
  pi: '#ec4899',
  codex: '#22c55e',
  gemini: '#eab308',
  droid: '#3b82f6',
  opencode: '#a855f7',
};

const fallbackColors: readonly string[] = ['#f97316', '#06b6d4', '#ef4444', '#84cc16', '#f43f5e'];

export function getSourceColor(source: string, index: number): string {
  return knownSourceColors[source] ?? fallbackColors[index % fallbackColors.length];
}

export function escapeSvg(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

const intFmt = new Intl.NumberFormat('en-US');
const decFmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatInteger(n: number): string {
  return intFmt.format(n);
}

export function formatDecimal(n: number | undefined): string {
  return n === undefined ? '-' : decFmt.format(n);
}

export function formatUsd(n: number | undefined): string {
  return n === undefined ? '-' : usdFmt.format(n);
}

export type Point = { x: number; y: number };

/**
 * Catmull-Rom spline interpolation for smooth stacked-area paths.
 * {@link yFloor} clamps control points to prevent curves from
 * overshooting below the chart baseline.
 */
export function catmullRom(points: Point[], tension = 0.3, yFloor?: number): string {
  if (points.length < 2) return '';

  const clamp = (y: number): number => (yFloor !== undefined ? Math.min(y, yFloor) : y);
  let d = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1.x + ((p2.x - p0.x) * tension) / 3;
    const cp1y = clamp(p1.y + ((p2.y - p0.y) * tension) / 3);
    const cp2x = p2.x - ((p3.x - p1.x) * tension) / 3;
    const cp2y = clamp(p2.y - ((p3.y - p1.y) * tension) / 3);

    d += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }

  return d;
}

export function scaleY(value: number, max: number, top: number, bottom: number): number {
  if (max <= 0) return bottom;
  return bottom - (Math.max(0, value) / max) * (bottom - top);
}
