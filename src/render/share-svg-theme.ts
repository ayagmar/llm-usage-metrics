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

export const SHARE_SVG_WIDTH = 1500;
export const SHARE_SVG_ACCENT_HEIGHT = 4;
export const SHARE_SVG_FOOTER_HEIGHT = 36;

const knownSourceColors: Readonly<Record<string, string>> = {
  pi: '#ec4899',
  codex: '#22c55e',
  gemini: '#eab308',
  droid: '#3b82f6',
  opencode: '#a855f7',
  claude: '#d97757',
};

const fallbackColors: readonly string[] = [
  '#f97316',
  '#06b6d4',
  '#ef4444',
  '#84cc16',
  '#f43f5e',
  '#14b8a6',
  '#8b5cf6',
  '#f59e0b',
  '#10b981',
  '#6366f1',
  '#d946ef',
  '#0ea5e9',
  '#f472b6',
  '#a3e635',
  '#fb923c',
  '#c084fc',
];

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

export function renderShareAccentBar(width = SHARE_SVG_WIDTH): string {
  return `<rect width="${width}" height="${SHARE_SVG_ACCENT_HEIGHT}" fill="url(#accent-grad)"/>`;
}

export function renderShareFooter(options: {
  height: number;
  width?: number;
  rightText?: string;
}): string {
  const width = options.width ?? SHARE_SVG_WIDTH;
  const footerTop = options.height - SHARE_SVG_FOOTER_HEIGHT;
  const textY = footerTop + SHARE_SVG_FOOTER_HEIGHT / 2 + 5;
  const lines = [
    `<line x1="0" y1="${footerTop + 1}" x2="${width}" y2="${footerTop + 1}" stroke="${shareTheme.gridLine}" stroke-width="1"/>`,
    `<text x="60" y="${textY}" fill="${shareTheme.textMuted}" font-family="${shareTheme.mono}" font-size="13">llm-usage-metrics</text>`,
  ];

  if (options.rightText !== undefined) {
    lines.push(
      `<text x="${width - 60}" y="${textY}" text-anchor="end" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}" font-size="13">${escapeSvg(options.rightText)}</text>`,
    );
  }

  return lines.join('\n');
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

export function formatApproxUsd(
  value: number | undefined,
  approximate: boolean | undefined,
): string {
  const formatted = formatUsd(value);
  return value !== undefined && approximate ? `~${formatted}` : formatted;
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
