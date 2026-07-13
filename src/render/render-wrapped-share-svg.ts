import type { WrappedRecap, WrappedTopItem } from '../wrapped/wrapped-recap.js';
import {
  escapeSvg,
  formatApproxUsd,
  formatCompact,
  formatInteger,
  renderShareCommandBadge,
  renderShareDocument,
  renderStatTile,
  SHARE_SVG_WIDTH,
  shareTheme,
  type StatTileGeometry,
} from './share-svg-theme.js';

const W = SHARE_SVG_WIDTH;
const H = 940;
const left = 80;
const right = 80;
const tileTop = 172;
// Five tiles between the margins: (1500 - 160 - 4 * 28) / 5 = 245.6, floored.
const tileWidth = 245;
const tileHeight = 126;
const tileGap = 28;
const listTop = 360;
const heatTitleTop = 668;
const heatGridTop = 726;
const heatCellSize = 20;
const heatCellPitch = 24;
const heatGridLeft = left + 42;
// Single-hue ramp (dark to light) matching the site accent, plus the empty-cell gray.
const levelColors = ['#21262d', '#4a2a1c', '#7d4224', '#c26535', '#f59d70'] as const;

function formatDayLabel(count: number): string {
  return count === 1 ? 'day' : 'days';
}

function formatHours(activeMs: number): string {
  const hours = Math.round(activeMs / 3_600_000);

  if (hours === 0) {
    return activeMs > 0 ? '<1h' : '0h';
  }

  return `${formatInteger(hours)}h`;
}

const tileGeometry: StatTileGeometry = {
  left,
  top: tileTop,
  width: tileWidth,
  height: tileHeight,
  gap: tileGap,
};

function renderWrappedStatTile(index: number, label: string, value: string, sublabel: string) {
  return renderStatTile(tileGeometry, index, label, value, sublabel);
}

// The card fits three rows; the recap carries up to five, so the SVG shows the top three.
const TOP_LIST_ROWS = 3;

function renderTopList(title: string, items: readonly WrappedTopItem[], x: number): string {
  const width = 640;
  const height = 260;
  const visibleItems = items.slice(0, TOP_LIST_ROWS);
  const rows =
    visibleItems.length === 0
      ? `<text x="${x + 28}" y="${listTop + 100}" font-size="18" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">No data</text>`
      : visibleItems
          .map((item, index) => {
            const rowY = listTop + 78 + index * 56;
            const rank = String(index + 1).padStart(2, '0');
            const cost = formatApproxUsd(item.costUsd, item.costIncomplete);
            const metric = `${formatCompact(item.totalTokens)} tokens | ${cost}`;

            return `<g data-top-item="${escapeSvg(title)}-${index + 1}">
<text x="${x + 28}" y="${rowY}" font-size="15" fill="${shareTheme.textMuted}" font-family="${shareTheme.mono}">${rank}</text>
<text x="${x + 76}" y="${rowY}" font-size="20" font-weight="700" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${escapeSvg(item.name)}</text>
<text x="${x + width - 28}" y="${rowY}" text-anchor="end" font-size="15" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">${escapeSvg(metric)}</text>
</g>`;
          })
          .join('\n');

  return `<g>
<rect x="${x}" y="${listTop}" width="${width}" height="${height}" rx="18" fill="${shareTheme.cardBg}" stroke="${shareTheme.cardBorder}"/>
<text x="${x + 28}" y="${listTop + 38}" font-size="22" font-weight="800" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${escapeSvg(title)}</text>
${rows}
</g>`;
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
const WEEKDAY_LABELS: readonly { row: number; label: string }[] = [
  { row: 1, label: 'Mon' },
  { row: 3, label: 'Wed' },
  { row: 5, label: 'Fri' },
];
const MS_PER_DAY = 86_400_000;

function renderHeatLegend(): string {
  const swatch = 12;
  const gap = 4;
  const rightEdge = W - right;
  const swatchesWidth = levelColors.length * (swatch + gap) - gap;
  const moreX = rightEdge;
  const swatchesX = rightEdge - 34 - swatchesWidth;
  const lessX = swatchesX - 8;
  const y = heatTitleTop + 18;
  const swatches = levelColors
    .map(
      (color, index) =>
        `<rect x="${swatchesX + index * (swatch + gap)}" y="${y}" width="${swatch}" height="${swatch}" rx="3" fill="${color}"/>`,
    )
    .join('\n');

  return `<g data-heat-legend="true">
<text x="${lessX}" y="${y + 10}" text-anchor="end" font-size="12" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">Less</text>
${swatches}
<text x="${moreX}" y="${y + 10}" text-anchor="end" font-size="12" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">More</text>
</g>`;
}

function renderDailyHeatmap(data: WrappedRecap): string {
  const yearStartDow = new Date(`${data.from}T00:00:00Z`).getUTCDay();
  const cells = data.dailyIntensity
    .map((day, index) => {
      const row = (yearStartDow + index) % 7;
      const column = Math.floor((yearStartDow + index) / 7);
      const x = heatGridLeft + column * heatCellPitch;
      const y = heatGridTop + row * heatCellPitch;

      return `<rect data-date="${escapeSvg(day.date)}" data-level="${day.level}" x="${x}" y="${y}" width="${heatCellSize}" height="${heatCellSize}" rx="4" fill="${levelColors[day.level]}"/>`;
    })
    .join('\n');
  const monthLabels = MONTH_LABELS.map((label, monthIndex) => {
    const dayOfYear = (Date.UTC(data.year, monthIndex, 1) - Date.UTC(data.year, 0, 1)) / MS_PER_DAY;
    const column = Math.floor((yearStartDow + dayOfYear) / 7);
    const x = heatGridLeft + column * heatCellPitch;

    return `<text x="${x}" y="${heatGridTop - 12}" font-size="12" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${label}</text>`;
  }).join('\n');
  const weekdayLabels = WEEKDAY_LABELS.map(
    ({ row, label }) =>
      `<text x="${heatGridLeft - 12}" y="${heatGridTop + row * heatCellPitch + 14}" text-anchor="end" font-size="12" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${label}</text>`,
  ).join('\n');

  return `<g>
<text x="${left}" y="${heatTitleTop}" font-size="24" font-weight="800" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">Daily activity</text>
<text x="${left}" y="${heatTitleTop + 26}" font-size="15" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">Tokens per day, shaded by quartile of your active days</text>
${renderHeatLegend()}
${monthLabels}
${weekdayLabels}
${cells}
</g>`;
}

export function renderWrappedShareSvg(data: WrappedRecap): string {
  const commandText = `llm-usage wrapped --year ${data.year} --share`;
  const cost = formatApproxUsd(data.costUsd, data.costIncomplete);
  const costSublabel =
    data.estimatedCacheSavingsUsd === undefined
      ? 'estimated spend'
      : `saved ${formatApproxUsd(data.estimatedCacheSavingsUsd, true)} via cache`;
  const footerLabel = `${data.from} to ${data.to}`;

  const body = `<text x="${left}" y="78" font-size="44" font-weight="900" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${data.year} Wrapped</text>
<text x="${left}" y="112" font-size="18" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">Your local LLM usage recap</text>
${renderShareCommandBadge(commandText)}
${renderWrappedStatTile(0, 'Tokens', formatCompact(data.totalTokens), `${formatInteger(data.eventCount)} events`)}
${renderWrappedStatTile(1, 'Cost', cost, costSublabel)}
${renderWrappedStatTile(2, 'Hours', formatHours(data.activeMs), `${formatInteger(data.sessionCount)} sessions`)}
${renderWrappedStatTile(3, 'Active Days', formatInteger(data.activeDays), 'this year')}
${renderWrappedStatTile(4, 'Streak', formatInteger(data.longestStreak), formatDayLabel(data.longestStreak))}
${renderTopList('Top Models', data.topModels, left)}
${renderTopList('Top Sources', data.topSources, W - right - 640)}
${renderDailyHeatmap(data)}`;

  return renderShareDocument({ height: H, body, footerRightText: footerLabel });
}
