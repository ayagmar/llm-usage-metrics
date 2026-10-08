/**
 * Design tokens and SVG building blocks shared by every share card.
 *
 * Every card is a fixed 1200x630 social image rendered once per theme. Figures
 * and the command line use a monospace face, so the card reads as the output of
 * a terminal tool; labels use the system sans.
 */

import type { ActivityDay } from '../aggregate/daily-activity.js';
import { getIsoDayOfWeekFromDateKey, shiftLocalDateKey } from '../utils/time-buckets.js';
import { segmentGraphemes } from './table-text-layout.js';

export type ShareThemeName = 'dark' | 'light';

export type ShareTheme = {
  name: ShareThemeName;
  bg: string;
  panel: string;
  line: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  /** The single highlight: hero figures and the hottest heatmap level. */
  accent: string;
  positive: string;
  negative: string;
  warning: string;
  /** Heatmap levels 0 (no usage) to 4; cool blues that end in the accent. */
  heat: readonly [string, string, string, string, string];
};

export const shareThemes: Readonly<Record<ShareThemeName, ShareTheme>> = {
  dark: {
    name: 'dark',
    bg: '#111830',
    panel: '#18213d',
    line: '#2a3557',
    text: '#eef1f8',
    textSecondary: '#a6b0c8',
    textMuted: '#6f7b9c',
    accent: '#ffb547',
    positive: '#5bd69a',
    negative: '#ff7f7f',
    warning: '#ffd166',
    heat: ['#1e2747', '#2f3e78', '#4c64c2', '#90a4ff', '#ffb547'],
  },
  light: {
    name: 'light',
    bg: '#f5f7fc',
    panel: '#ffffff',
    line: '#dde2ef',
    text: '#121933',
    textSecondary: '#46516f',
    textMuted: '#7a84a3',
    accent: '#b45f00',
    positive: '#13804c',
    negative: '#c3343a',
    warning: '#9a6a00',
    heat: ['#e5e9f4', '#c3ccf1', '#8c9be8', '#4a5dc6', '#e08a00'],
  },
};

export const SHARE_WIDTH = 1200;
export const SHARE_HEIGHT = 630;
/** Left and right margin of every card. */
export const SHARE_MARGIN = 64;
/** Top of the area below the card title. */
const SHARE_BODY_TOP = 150;
/** Bottom of the area above the footer. */
const SHARE_BODY_BOTTOM = 560;

export const shareFonts = {
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  mono: "'JetBrains Mono', 'SF Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace",
} as const;

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

/** Shortens a label to `maxChars` with an ellipsis, so long names cannot overflow a card. */
export function truncateLabel(value: string, maxChars: number): string {
  const graphemes = segmentGraphemes(value);
  return graphemes.length <= maxChars ? value : `${graphemes.slice(0, maxChars - 1).join('')}…`;
}

export type SvgTextOptions = {
  size: number;
  fill: string;
  weight?: number;
  mono?: boolean;
  anchor?: 'start' | 'middle' | 'end';
  /** Extra attributes, already escaped. */
  attributes?: string;
  /** A smaller sans run after the content, such as a unit. */
  suffix?: { text: string; size: number; fill: string };
};

/** One `<text>` element; `content` is escaped here. */
export function svgText(x: number, y: number, content: string, options: SvgTextOptions): string {
  const anchor =
    options.anchor && options.anchor !== 'start' ? ` text-anchor="${options.anchor}"` : '';
  const weight = options.weight === undefined ? '' : ` font-weight="${options.weight}"`;
  const family = options.mono ? shareFonts.mono : shareFonts.sans;
  const attributes = options.attributes === undefined ? '' : ` ${options.attributes}`;
  const suffix =
    options.suffix === undefined
      ? ''
      : `<tspan dx="${Math.round(options.suffix.size * 0.3)}" font-size="${options.suffix.size}" font-weight="400" fill="${options.suffix.fill}" font-family="${shareFonts.sans}">${escapeSvg(options.suffix.text)}</tspan>`;

  return `<text x="${round(x)}" y="${round(y)}"${anchor} font-size="${options.size}"${weight} fill="${options.fill}" font-family="${family}"${attributes}>${escapeSvg(content)}${suffix}</text>`;
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export type ShareCardOptions = {
  theme: ShareTheme;
  title: string;
  subtitle: string;
  /** The command that reproduces the card, shown in the footer. */
  command: string;
  /** Right side of the footer, usually the date range. */
  footnote?: string;
  body: string;
  defs?: string;
};

/** The frame every card shares: background, title block, wordmark, and footer. */
export function renderShareCard(options: ShareCardOptions): string {
  const { theme } = options;
  const footerY = SHARE_HEIGHT - 34;
  const right = SHARE_WIDTH - SHARE_MARGIN;
  const footnote =
    options.footnote === undefined
      ? ''
      : svgText(right, footerY, options.footnote, {
          size: 15,
          fill: theme.textMuted,
          anchor: 'end',
        });
  const defs = options.defs === undefined ? '' : `<defs>\n${options.defs}\n</defs>\n`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_WIDTH}" height="${SHARE_HEIGHT}" viewBox="0 0 ${SHARE_WIDTH} ${SHARE_HEIGHT}" data-theme="${theme.name}">
${defs}<rect width="${SHARE_WIDTH}" height="${SHARE_HEIGHT}" fill="${theme.bg}"/>
${svgText(SHARE_MARGIN, 82, options.title, { size: 34, weight: 700, fill: theme.text })}
${svgText(SHARE_MARGIN, 114, options.subtitle, { size: 17, fill: theme.textSecondary })}
${svgText(right, 74, 'llm-usage-metrics', { size: 15, fill: theme.textMuted, mono: true, anchor: 'end' })}
${options.body}
<line x1="${SHARE_MARGIN}" y1="${SHARE_HEIGHT - 66}" x2="${right}" y2="${SHARE_HEIGHT - 66}" stroke="${theme.line}" stroke-width="1"/>
${svgText(SHARE_MARGIN, footerY, `$ ${options.command}`, { size: 15, fill: theme.textMuted, mono: true })}
${footnote}
</svg>`;
}

export type StatOptions = {
  theme: ShareTheme;
  x: number;
  y: number;
  label: string;
  value: string;
  detail?: string;
  /** Unit set smaller after the value, e.g. "days". */
  unit?: string;
  /** Font size of the value; the label and detail stay fixed. */
  size?: number;
  accent?: boolean;
  anchor?: 'start' | 'end';
};

/** A labelled figure: sans label on top, monospace value, optional muted detail below. */
export function renderStat(options: StatOptions): string {
  const { theme } = options;
  const size = options.size ?? 34;
  const anchor = options.anchor ?? 'start';
  const valueY = options.y + 12 + size;
  const parts = [
    svgText(options.x, options.y, options.label, {
      size: 16,
      fill: theme.textSecondary,
      anchor,
    }),
    svgText(options.x, valueY, options.value, {
      size,
      weight: 700,
      fill: options.accent ? theme.accent : theme.text,
      mono: true,
      anchor,
      suffix:
        options.unit === undefined
          ? undefined
          : { text: options.unit, size: Math.round(size * 0.42), fill: theme.textSecondary },
    }),
  ];

  if (options.detail !== undefined) {
    parts.push(
      svgText(options.x, valueY + Math.max(26, Math.round(size * 0.5)), options.detail, {
        size: 15,
        fill: theme.textMuted,
        anchor,
      }),
    );
  }

  return `<g data-stat="${escapeSvg(options.label)}">\n${parts.join('\n')}\n</g>`;
}

/** Centered message for a card without data. */
export function renderEmptyState(theme: ShareTheme, message: string): string {
  return svgText(SHARE_WIDTH / 2, (SHARE_BODY_TOP + SHARE_BODY_BOTTOM) / 2, message, {
    size: 22,
    fill: theme.textSecondary,
    anchor: 'middle',
    attributes: 'data-empty-state="true"',
  });
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const WEEKDAY_LABELS = [
  { row: 0, label: 'Mon' },
  { row: 2, label: 'Wed' },
  { row: 4, label: 'Fri' },
];

export type ActivityGridOptions = {
  theme: ShareTheme;
  days: readonly ActivityDay[];
  /** Left edge of the first week column; weekday labels sit to its left. */
  x: number;
  /** Top of the Monday row; month labels sit above it. */
  y: number;
  /** Distance between cell origins. */
  pitch: number;
};

/** Width of a grid of `weekCount` columns. */
export function activityGridWidth(weekCount: number, pitch: number): number {
  return weekCount * pitch - Math.round(pitch * 0.2);
}

/** Number of Monday-first week columns the days span. */
export function countActivityWeeks(days: readonly ActivityDay[]): number {
  if (days.length === 0) {
    return 0;
  }

  return Math.ceil((getIsoDayOfWeekFromDateKey(days[0].date) - 1 + days.length) / 7);
}

/**
 * GitHub-style grid: one column per Monday-first week, one row per weekday.
 * The first column starts on the weekday of the first day.
 */
export function renderActivityGrid(options: ActivityGridOptions): string {
  const { theme, days, pitch } = options;

  if (days.length === 0) {
    return '';
  }

  const cell = pitch - Math.round(pitch * 0.2);
  const radius = Math.max(2, Math.round(cell / 4));
  const offset = getIsoDayOfWeekFromDateKey(days[0].date) - 1;
  const cells: string[] = [];
  const monthLabels: string[] = [];
  let previousLabelX = Number.NEGATIVE_INFINITY;

  days.forEach((day, index) => {
    const column = Math.floor((offset + index) / 7);
    const row = (offset + index) % 7;
    const x = options.x + column * pitch;

    cells.push(
      `<rect data-date="${escapeSvg(day.date)}" data-level="${day.level}" x="${x}" y="${options.y + row * pitch}" width="${cell}" height="${cell}" rx="${radius}" fill="${theme.heat[day.level]}"/>`,
    );

    // Label a month at the first column whose Monday falls in it (or the first column).
    const isFirstCell = index === 0;
    const startsMonthColumn =
      row === 0 && shiftLocalDateKey(day.date, -7).slice(5, 7) !== day.date.slice(5, 7);

    if ((isFirstCell || startsMonthColumn) && x - previousLabelX >= 3 * pitch) {
      monthLabels.push(
        svgText(x, options.y - 10, MONTH_LABELS[Number(day.date.slice(5, 7)) - 1], {
          size: 13,
          fill: theme.textMuted,
        }),
      );
      previousLabelX = x;
    }
  });

  const weekdayLabels = WEEKDAY_LABELS.map(({ row, label }) =>
    svgText(options.x - 10, options.y + row * pitch + cell - 2, label, {
      size: 13,
      fill: theme.textMuted,
      anchor: 'end',
    }),
  );

  return `<g data-activity-grid="true">
${monthLabels.join('\n')}
${weekdayLabels.join('\n')}
${cells.join('\n')}
</g>`;
}

/** "Less ■■■■■ More" legend, right-aligned at `right`. */
export function renderHeatLegend(theme: ShareTheme, right: number, y: number): string {
  const swatch = 12;
  const gap = 4;
  const swatchesWidth = theme.heat.length * (swatch + gap) - gap;
  const swatchesX = right - 40 - swatchesWidth;
  const swatches = theme.heat
    .map(
      (color, index) =>
        `<rect x="${swatchesX + index * (swatch + gap)}" y="${y - 10}" width="${swatch}" height="${swatch}" rx="3" fill="${color}"/>`,
    )
    .join('\n');

  return `<g data-heat-legend="true">
${svgText(swatchesX - 8, y, 'Less', { size: 13, fill: theme.textMuted, anchor: 'end' })}
${swatches}
${svgText(right, y, 'More', { size: 13, fill: theme.textMuted, anchor: 'end' })}
</g>`;
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

export function formatDayUnit(count: number): string {
  return count === 1 ? 'day' : 'days';
}

export function scaleY(value: number, max: number, top: number, bottom: number): number {
  if (max <= 0) return bottom;
  return bottom - (Math.max(0, value) / max) * (bottom - top);
}
