import type { EfficiencyDataResult } from '../cli/usage-data-contracts.js';
import type { EfficiencyRow } from '../efficiency/efficiency-row.js';
import {
  catmullRom,
  escapeSvg,
  formatDecimal,
  formatInteger,
  formatUsd,
  scaleY,
  shareTheme,
  type Point,
} from './share-svg-theme.js';

const W = 1500;
const H = 640;
const pad = { top: 160, right: 110, bottom: 70, left: 110 };

function toMonthlyRows(rows: EfficiencyRow[]): EfficiencyRow[] {
  return rows
    .filter((row) => row.rowType === 'period')
    .sort((a, b) => a.periodKey.localeCompare(b.periodKey));
}

function toAllRow(rows: EfficiencyRow[]): EfficiencyRow | undefined {
  return rows.find((row) => row.periodKey === 'ALL');
}

function renderSummaryStats(allRow: EfficiencyRow | undefined, vcenter: number): string {
  const cost = formatUsd(allRow?.costUsd);
  const commits = formatInteger(allRow?.commitCount ?? 0);
  const usdPerCommit = formatUsd(allRow?.usdPerCommit);
  const tokPerCommit = formatDecimal(allRow?.tokensPerCommit);

  const y = vcenter;
  const items = [
    { label: 'Total Cost', value: cost, x: pad.left },
    { label: 'Commits', value: commits, x: 280 },
    { label: '$/Commit', value: usdPerCommit, x: 480 },
    { label: 'Tokens/Commit', value: tokPerCommit, x: 680 },
  ];

  return items
    .map(
      (item) =>
        `<text x="${item.x}" y="${y}" font-size="14" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(item.label)}</text>` +
        `<text x="${item.x}" y="${y + 20}" font-size="18" font-weight="700" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${escapeSvg(item.value)}</text>`,
    )
    .join('\n');
}

const chartColors = {
  commits: '#8b949e',
  usdPerCommit: '#f97316',
  tokensPerCommit: '#22c55e',
} as const;

function renderEfficiencyLegend(x: number, y: number): string {
  const items = [
    { label: 'Commits', color: chartColors.commits, shape: 'rect' as const },
    { label: '$ / Commit', color: chartColors.usdPerCommit, shape: 'line' as const },
    { label: 'Non-Cache Tok / Commit', color: chartColors.tokensPerCommit, shape: 'line' as const },
  ];

  return items
    .map((item, i) => {
      const ix = x + i * 200;
      const shape =
        item.shape === 'rect'
          ? `<rect x="${ix}" y="${y - 6}" width="14" height="14" rx="3" fill="${item.color}" opacity="0.5"/>`
          : `<line x1="${ix}" y1="${y + 1}" x2="${ix + 14}" y2="${y + 1}" stroke="${item.color}" stroke-width="3" stroke-linecap="round"/>`;
      return `${shape}<text x="${ix + 20}" y="${y + 5}" font-size="13" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">${escapeSvg(item.label)}</text>`;
    })
    .join('\n');
}

export function renderEfficiencyMonthlyShareSvg(efficiencyData: EfficiencyDataResult): string {
  const monthlyRows = toMonthlyRows(efficiencyData.rows);
  const allRow = toAllRow(efficiencyData.rows);

  const chartLeft = pad.left;
  const chartTop = pad.top;
  const chartRight = W - pad.right;
  const chartBottom = H - pad.bottom;
  const chartW = chartRight - chartLeft;

  const count = Math.max(1, monthlyRows.length);
  const stepX = count === 1 ? 0 : chartW / (count - 1);

  const maxCommits = Math.max(1, ...monthlyRows.map((r) => r.commitCount));
  const maxUsd = Math.max(1, ...monthlyRows.map((r) => Math.max(0, r.usdPerCommit ?? 0)));
  const maxNonCache = Math.max(
    1,
    ...monthlyRows.map((r) => Math.max(0, r.nonCacheTokensPerCommit ?? 0)),
  );

  const barWidth = Math.min(42, Math.max(14, chartW / (count * 2.4)));

  const commitBars = monthlyRows
    .map((row, i) => {
      const x = chartLeft + i * stepX;
      const yTop = scaleY(row.commitCount, maxCommits, chartTop, chartBottom);
      return `<rect x="${(x - barWidth / 2).toFixed(2)}" y="${yTop.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${(chartBottom - yTop).toFixed(2)}" rx="4" fill="${chartColors.commits}" fill-opacity="0.35"/>`;
    })
    .join('\n');

  const usdPoints: Point[] = monthlyRows.map((row, i) => ({
    x: chartLeft + i * stepX,
    y: scaleY(row.usdPerCommit ?? 0, maxUsd, chartTop, chartBottom),
  }));

  const nonCachePoints: Point[] = monthlyRows.map((row, i) => ({
    x: chartLeft + i * stepX,
    y: scaleY(row.nonCacheTokensPerCommit ?? 0, maxNonCache, chartTop, chartBottom),
  }));

  const usdLine =
    usdPoints.length >= 2
      ? `<path d="${catmullRom(usdPoints, 0.3, chartBottom)}" fill="none" stroke="${chartColors.usdPerCommit}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
      : '';

  const nonCacheLine =
    nonCachePoints.length >= 2
      ? `<path d="${catmullRom(nonCachePoints, 0.3, chartBottom)}" fill="none" stroke="${chartColors.tokensPerCommit}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
      : '';

  const usdDots = usdPoints
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="4.5" fill="${chartColors.usdPerCommit}"/>`,
    )
    .join('\n');

  const nonCacheDots = nonCachePoints
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="4.5" fill="${chartColors.tokensPerCommit}"/>`,
    )
    .join('\n');

  const monthLabels = monthlyRows
    .map((row, i) => {
      const x = chartLeft + i * stepX;
      return `<text x="${x.toFixed(2)}" y="${(chartBottom + 28).toFixed(0)}" text-anchor="middle" font-size="13" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(row.periodKey)}</text>`;
    })
    .join('\n');

  const axisLabels = [
    `<text x="${(chartLeft - 12).toFixed(0)}" y="${(chartTop + 5).toFixed(0)}" text-anchor="end" font-size="12" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(formatInteger(maxCommits))}</text>`,
    `<text x="${(chartLeft - 12).toFixed(0)}" y="${(chartBottom + 5).toFixed(0)}" text-anchor="end" font-size="12" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">0</text>`,
    `<text x="${(chartRight + 12).toFixed(0)}" y="${(chartTop + 5).toFixed(0)}" font-size="11" fill="${chartColors.usdPerCommit}" font-family="${shareTheme.font}">$/c max ${escapeSvg(formatUsd(maxUsd))}</text>`,
    `<text x="${(chartRight + 12).toFixed(0)}" y="${(chartTop + 22).toFixed(0)}" font-size="11" fill="${chartColors.tokensPerCommit}" font-family="${shareTheme.font}">tok/c max ${escapeSvg(formatDecimal(maxNonCache))}</text>`,
  ].join('\n');

  const noData =
    monthlyRows.length === 0
      ? `<text x="${(W / 2).toFixed(0)}" y="${(H / 2).toFixed(0)}" text-anchor="middle" font-size="20" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">No monthly efficiency data available</text>`
      : '';

  const vcenter = 70;
  const commandText = 'llm-usage efficiency monthly --share';
  const badgeW = commandText.length * 9.5 + 28;
  const badgeX = W - pad.right - badgeW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${shareTheme.bg}"/>
<text x="${pad.left}" y="52" font-size="32" font-weight="700" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">Monthly Efficiency</text>
<rect x="${badgeX.toFixed(0)}" y="30" width="${badgeW.toFixed(0)}" height="34" rx="8" fill="${shareTheme.cardBg}" stroke="${shareTheme.cardBorder}"/>
<text x="${(badgeX + badgeW / 2).toFixed(0)}" y="52" text-anchor="middle" font-size="14" fill="${shareTheme.textSecondary}" font-family="${shareTheme.mono}">${escapeSvg(commandText)}</text>
${renderSummaryStats(allRow, vcenter)}
${renderEfficiencyLegend(pad.left, vcenter + 50)}
<line x1="${chartLeft}" y1="${chartBottom}" x2="${chartRight}" y2="${chartBottom}" stroke="${shareTheme.gridLine}" stroke-width="1"/>
<line x1="${chartLeft}" y1="${chartTop}" x2="${chartLeft}" y2="${chartBottom}" stroke="${shareTheme.gridLine}" stroke-width="1"/>
<line x1="${chartRight}" y1="${chartTop}" x2="${chartRight}" y2="${chartBottom}" stroke="${shareTheme.gridLine}" stroke-width="1"/>
${axisLabels}
${commitBars}
${usdLine}
${nonCacheLine}
${usdDots}
${nonCacheDots}
${monthLabels}
${noData}
</svg>`;
}
