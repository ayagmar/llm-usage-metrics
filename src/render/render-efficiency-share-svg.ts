import type { EfficiencyDataResult } from '../cli/usage-data-contracts.js';
import type {
  EfficiencyGrandTotalRow,
  EfficiencyPeriodRow,
  EfficiencyRow,
} from '../efficiency/efficiency-row.js';
import {
  catmullRom,
  escapeSvg,
  formatDecimal,
  formatInteger,
  formatUsd,
  renderShareCommandBadge,
  renderShareDocument,
  scaleY,
  SHARE_SVG_WIDTH,
  shareTheme,
  type Point,
} from './share-svg-theme.js';

const W = SHARE_SVG_WIDTH;
const H = 720;
const left = 120;
const right = 80;

// Two stacked panels with their own scales replace the old dual-axis chart:
// $/Commit reads as a line on top, commits as bars below, sharing the months.
const usdPanel = { top: 190, bottom: 420 };
const commitPanel = { top: 480, bottom: 610 };
const monthLabelY = 640;

const chartColors = {
  commits: '#8b949e',
  usdPerCommit: '#f97316',
} as const;

function isPeriodRow(row: EfficiencyRow): row is EfficiencyPeriodRow {
  return row.rowType === 'period';
}

function isGrandTotalRow(row: EfficiencyRow): row is EfficiencyGrandTotalRow {
  return row.rowType === 'grand_total';
}

function toMonthlyRows(rows: EfficiencyRow[]): EfficiencyPeriodRow[] {
  return rows.filter(isPeriodRow).sort((a, b) => a.periodKey.localeCompare(b.periodKey));
}

function toAllRow(rows: EfficiencyRow[]): EfficiencyGrandTotalRow | undefined {
  return rows.find(isGrandTotalRow);
}

function renderSummaryStats(allRow: EfficiencyGrandTotalRow | undefined): string {
  const items = [
    { label: 'Total Cost', value: formatUsd(allRow?.costUsd), x: left },
    { label: 'Commits', value: formatInteger(allRow?.commitCount ?? 0), x: left + 240 },
    { label: '$/Commit', value: formatUsd(allRow?.usdPerCommit), x: left + 480 },
    { label: 'Tokens/Commit', value: formatDecimal(allRow?.tokensPerCommit), x: left + 720 },
  ];

  return items
    .map(
      (item) =>
        `<text x="${item.x}" y="96" font-size="13" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(item.label)}</text>` +
        `<text x="${item.x}" y="122" font-size="22" font-weight="700" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${escapeSvg(item.value)}</text>`,
    )
    .join('\n');
}

function renderPanelFrame(panel: { top: number; bottom: number }): string {
  return `<line x1="${left}" y1="${panel.bottom}" x2="${W - right}" y2="${panel.bottom}" stroke="${shareTheme.gridLine}" stroke-width="1"/>`;
}

function renderPanelLabel(
  panel: { top: number; bottom: number },
  label: string,
  color: string,
  maxLabel: string,
): string {
  return [
    `<text x="${left}" y="${panel.top - 14}" font-size="13" font-weight="600" fill="${color}" font-family="${shareTheme.font}">${escapeSvg(label)}</text>`,
    `<text x="${W - right}" y="${panel.top - 14}" text-anchor="end" font-size="11" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">max ${escapeSvg(maxLabel)}</text>`,
  ].join('\n');
}

export function renderEfficiencyMonthlyShareSvg(efficiencyData: EfficiencyDataResult): string {
  const monthlyRows = toMonthlyRows(efficiencyData.rows);
  const allRow = toAllRow(efficiencyData.rows);

  const chartW = W - left - right;
  const count = Math.max(1, monthlyRows.length);
  const stepX = count === 1 ? 0 : chartW / (count - 1);
  const toX = (index: number): number => (count === 1 ? left + chartW / 2 : left + index * stepX);

  const maxCommits = Math.max(1, ...monthlyRows.map((r) => r.commitCount));
  const actualMaxUsd = Math.max(0, ...monthlyRows.map((r) => Math.max(0, r.usdPerCommit ?? 0)));
  const scaleMaxUsd = Math.max(0.01, actualMaxUsd) * 1.08;

  const usdPoints: Point[] = monthlyRows.map((row, i) => ({
    x: toX(i),
    y: scaleY(row.usdPerCommit ?? 0, scaleMaxUsd, usdPanel.top, usdPanel.bottom),
  }));

  const usdArea =
    usdPoints.length >= 2
      ? `<path d="${catmullRom(usdPoints, 0.3, usdPanel.bottom)} L${usdPoints[usdPoints.length - 1].x.toFixed(2)},${usdPanel.bottom} L${usdPoints[0].x.toFixed(2)},${usdPanel.bottom} Z" fill="url(#usd-area-grad)"/>`
      : '';
  const usdLine =
    usdPoints.length >= 2
      ? `<path d="${catmullRom(usdPoints, 0.3, usdPanel.bottom)}" fill="none" stroke="${chartColors.usdPerCommit}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
      : '';
  const dotRadius = count <= 4 ? 6 : 4.5;
  const usdDots = usdPoints
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${dotRadius}" fill="${chartColors.usdPerCommit}"/>`,
    )
    .join('\n');
  const usdLabels = monthlyRows
    .map((row, i) => {
      const val = row.usdPerCommit;
      if (val === undefined) return '';
      const p = usdPoints[i];
      return `<text x="${p.x.toFixed(2)}" y="${(p.y - 14).toFixed(0)}" text-anchor="middle" font-size="12" font-weight="600" fill="${chartColors.usdPerCommit}" font-family="${shareTheme.font}">${escapeSvg(formatUsd(val))}</text>`;
    })
    .join('\n');

  const barWidth = Math.min(48, Math.max(18, chartW / (count * 2.2)));
  const commitBars = monthlyRows
    .map((row, i) => {
      const x = toX(i);
      const yTop = scaleY(row.commitCount, maxCommits * 1.08, commitPanel.top, commitPanel.bottom);
      return `<rect x="${(x - barWidth / 2).toFixed(2)}" y="${yTop.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${(commitPanel.bottom - yTop).toFixed(2)}" rx="4" fill="${chartColors.commits}" fill-opacity="0.45"/>`;
    })
    .join('\n');
  const commitLabels = monthlyRows
    .map((row, i) => {
      const x = toX(i);
      const yTop = scaleY(row.commitCount, maxCommits * 1.08, commitPanel.top, commitPanel.bottom);
      return `<text x="${x.toFixed(2)}" y="${(yTop - 8).toFixed(0)}" text-anchor="middle" font-size="12" font-weight="600" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">${escapeSvg(formatInteger(row.commitCount))}</text>`;
    })
    .join('\n');

  const monthLabels = monthlyRows
    .map(
      (row, i) =>
        `<text x="${toX(i).toFixed(2)}" y="${monthLabelY}" text-anchor="middle" font-size="13" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(row.periodKey)}</text>`,
    )
    .join('\n');

  const noData =
    monthlyRows.length === 0
      ? `<text x="${(W / 2).toFixed(0)}" y="${(H / 2).toFixed(0)}" text-anchor="middle" font-size="20" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">No monthly efficiency data available</text>`
      : '';

  const extraDefs = `<linearGradient id="usd-area-grad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${chartColors.usdPerCommit}" stop-opacity="0.28"/>
    <stop offset="100%" stop-color="${chartColors.usdPerCommit}" stop-opacity="0.04"/>
  </linearGradient>`;
  const body = `<text x="${left}" y="52" font-size="32" font-weight="700" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">Monthly Efficiency</text>
<text x="${left}" y="76" font-size="15" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">Spend per commit and commit volume, month by month</text>
${renderShareCommandBadge('llm-usage efficiency monthly --share')}
${renderSummaryStats(allRow)}
${renderPanelLabel(usdPanel, '$ / Commit', chartColors.usdPerCommit, formatUsd(actualMaxUsd))}
${renderPanelFrame(usdPanel)}
${usdArea}
${usdLine}
${usdDots}
${usdLabels}
${renderPanelLabel(commitPanel, 'Commits', chartColors.commits, formatInteger(maxCommits))}
${renderPanelFrame(commitPanel)}
${commitBars}
${commitLabels}
${monthLabels}
${noData}`;

  return renderShareDocument({ height: H, extraDefs, body });
}
