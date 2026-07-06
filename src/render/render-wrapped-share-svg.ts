import type { WrappedRecap, WrappedTopItem } from '../wrapped/wrapped-recap.js';
import {
  escapeSvg,
  formatCompact,
  formatInteger,
  formatUsd,
  renderShareAccentBar,
  renderShareFooter,
  SHARE_SVG_WIDTH,
  shareTheme,
} from './share-svg-theme.js';

const W = SHARE_SVG_WIDTH;
const H = 900;
const left = 80;
const right = 80;
const tileTop = 172;
const tileWidth = 300;
const tileHeight = 126;
const tileGap = 28;
const listTop = 360;
const monthTop = 700;
const levelColors = ['#21262d', '#14532d', '#15803d', '#22c55e', '#86efac'] as const;

function formatApproxUsd(value: number | undefined, approximate: boolean | undefined): string {
  const formatted = formatUsd(value);
  return value !== undefined && approximate ? `~${formatted}` : formatted;
}

function formatDayLabel(count: number): string {
  return count === 1 ? 'day' : 'days';
}

function renderStatTile(index: number, label: string, value: string, sublabel: string): string {
  const x = left + index * (tileWidth + tileGap);
  const y = tileTop;

  return `<g data-stat-tile="${escapeSvg(label)}">
<rect x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}" rx="18" fill="${shareTheme.cardBg}" stroke="${shareTheme.cardBorder}"/>
<text x="${x + 24}" y="${y + 42}" font-size="14" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">${escapeSvg(label)}</text>
<text x="${x + 24}" y="${y + 82}" font-size="34" font-weight="800" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${escapeSvg(value)}</text>
<text x="${x + 24}" y="${y + 108}" font-size="13" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(sublabel)}</text>
</g>`;
}

function renderTopList(title: string, items: readonly WrappedTopItem[], x: number): string {
  const width = 640;
  const height = 260;
  const rows =
    items.length === 0
      ? `<text x="${x + 28}" y="${listTop + 100}" font-size="18" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">No data</text>`
      : items
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

function renderMonthlyIntensity(data: WrappedRecap): string {
  const availableWidth = W - left - right;
  const gap = 12;
  const cellWidth = (availableWidth - gap * 11) / 12;
  const monthLabels = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  const cells = data.monthlyIntensity
    .map((month, index) => {
      const x = left + index * (cellWidth + gap);
      const labelX = x + cellWidth / 2;
      const color = levelColors[month.level];

      return `<g data-month="${escapeSvg(month.month)}" data-level="${month.level}">
<rect x="${x.toFixed(2)}" y="${monthTop}" width="${cellWidth.toFixed(2)}" height="74" rx="14" fill="${color}" stroke="${shareTheme.cardBorder}"/>
<text x="${labelX.toFixed(2)}" y="${monthTop + 103}" text-anchor="middle" font-size="13" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${monthLabels[index]}</text>
</g>`;
    })
    .join('\n');

  return `<g>
<text x="${left}" y="${monthTop - 34}" font-size="24" font-weight="800" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">Monthly intensity</text>
<text x="${left}" y="${monthTop - 10}" font-size="15" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">Token usage scaled against your busiest month</text>
${cells}
</g>`;
}

export function renderWrappedShareSvg(data: WrappedRecap): string {
  const commandText = `llm-usage wrapped --year ${data.year} --share`;
  const cost = formatApproxUsd(data.totalCostUsd, data.costIncomplete);
  const badgeW = commandText.length * 9.5 + 28;
  const badgeX = W - right - badgeW;
  const footerLabel = `${data.from} to ${data.to}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="accent-grad" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#f97316"/>
    <stop offset="50%" stop-color="#22c55e"/>
    <stop offset="100%" stop-color="#06b6d4"/>
  </linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="${shareTheme.bg}"/>
${renderShareAccentBar()}
<text x="${left}" y="78" font-size="44" font-weight="900" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${data.year} Wrapped</text>
<text x="${left}" y="112" font-size="18" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">Your local LLM usage recap</text>
<rect x="${badgeX.toFixed(0)}" y="54" width="${badgeW.toFixed(0)}" height="34" rx="17" fill="none" stroke="${shareTheme.cardBorder}"/>
<text x="${(badgeX + badgeW / 2).toFixed(0)}" y="76" text-anchor="middle" font-size="14" fill="${shareTheme.textMuted}" font-family="${shareTheme.mono}">${escapeSvg(commandText)}</text>
${renderStatTile(0, 'Tokens', formatCompact(data.totalTokens), `${formatInteger(data.eventCount)} events`)}
${renderStatTile(1, 'Cost', cost, 'estimated spend')}
${renderStatTile(2, 'Active Days', formatInteger(data.activeDays), `${formatInteger(data.sessionCount)} sessions`)}
${renderStatTile(3, 'Streak', formatInteger(data.longestStreak), formatDayLabel(data.longestStreak))}
${renderTopList('Top Models', data.topModels, left)}
${renderTopList('Top Sources', data.topSources, W - right - 640)}
${renderMonthlyIntensity(data)}
${renderShareFooter({ height: H, rightText: footerLabel })}
</svg>`;
}
