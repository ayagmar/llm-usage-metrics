import type { UsageDataResult } from '../cli/usage-data-contracts.js';
import type { GrandTotalRow, PeriodSourceRow, UsageReportRow } from '../domain/usage-report-row.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import {
  catmullRom,
  escapeSvg,
  formatCompact,
  formatUsd,
  getSourceColor,
  scaleY,
  shareTheme,
  type Point,
} from './share-svg-theme.js';

const W = 1500;
const H = 560;
const ACCENT_H = 4;
const FOOTER_H = 36;
const pad = { top: 140, right: 80, bottom: 60 + FOOTER_H, left: 200 };
const STAT_X = 60;
const STAT_VALUE_FONT_SIZE = 52;
const STAT_VALUE_WIDTH_FACTOR = 0.6;
const SOURCE_PILLS_MIN_X = pad.left + 10;
const SOURCE_PILLS_STAT_GAP = 24;

type SourceSeries = {
  source: string;
  color: string;
  total: number;
  values: number[];
};

function extractPeriodSourceRows(rows: UsageReportRow[]): PeriodSourceRow[] {
  return rows.filter((r): r is PeriodSourceRow => r.rowType === 'period_source');
}

function extractGrandTotal(rows: UsageReportRow[]): GrandTotalRow | undefined {
  return rows.find((r): r is GrandTotalRow => r.rowType === 'grand_total');
}

function buildSourceSeries(
  sourceRows: PeriodSourceRow[],
  periods: string[],
  sources: string[],
): SourceSeries[] {
  const lookup = new Map<string, number>();
  const sourceTotals = new Map<string, number>();

  for (const row of sourceRows) {
    const key = `${row.source}__${row.periodKey}`;
    lookup.set(key, (lookup.get(key) ?? 0) + row.totalTokens);
    sourceTotals.set(row.source, (sourceTotals.get(row.source) ?? 0) + row.totalTokens);
  }

  return sources.map((source, index) => ({
    source,
    color: getSourceColor(source, index),
    total: sourceTotals.get(source) ?? 0,
    values: periods.map((period) => lookup.get(`${source}__${period}`) ?? 0),
  }));
}

function buildStackedValues(series: SourceSeries[]): number[][] {
  if (series.length === 0) return [];

  const periodCount = series[0].values.length;
  const stacked: number[][] = [];

  for (let s = 0; s < series.length; s++) {
    stacked.push(
      Array.from({ length: periodCount }, (_, p) => {
        let sum = 0;
        for (let si = 0; si <= s; si++) sum += series[si].values[p];
        return sum;
      }),
    );
  }

  return stacked;
}

/** Thin gradient accent strip at the SVG top edge (gradient defined in main defs). */
function renderAccentBar(): string {
  return `<rect width="${W}" height="${ACCENT_H}" fill="url(#accent-grad)"/>`;
}

/** Left-side stat column: big token count + cost. */
function renderStatColumn(
  totalTokens: number,
  costUsd: number | undefined,
  sourceCount: number,
): string {
  const x = STAT_X;
  const baseY = ACCENT_H + 48;
  let svg = '';

  svg += `<text x="${x}" y="${baseY}" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}" font-size="52" font-weight="800">${escapeSvg(formatCompact(totalTokens))}</text>\n`;
  svg += `<text x="${x}" y="${baseY + 22}" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}" font-size="14" letter-spacing="3" font-weight="600">TOKENS</text>\n`;

  if (costUsd !== undefined) {
    svg += `<text x="${x}" y="${baseY + 50}" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}" font-size="22" font-weight="600">${escapeSvg(formatUsd(costUsd))}</text>\n`;
  }

  svg += `<text x="${x}" y="${baseY + 74}" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}" font-size="13">${sourceCount} source${sourceCount !== 1 ? 's' : ''}</text>\n`;

  return svg;
}

/** Source pills: rounded pill badges across the top-right. */
function renderSourcePills(series: SourceSeries[], startX: number): string {
  let svg = '';
  let cx = Math.max(SOURCE_PILLS_MIN_X, startX);
  const pillY = ACCENT_H + 30;

  for (const s of series) {
    const label = `${s.source}  ${formatCompact(s.total)}`;
    const textW = label.length * 8.5;
    const pillW = textW + 28;
    const pillH = 30;

    svg += `<rect x="${cx}" y="${pillY}" width="${pillW.toFixed(0)}" height="${pillH}" rx="${pillH / 2}" fill="${s.color}" fill-opacity="0.15" stroke="${s.color}" stroke-opacity="0.4" stroke-width="1"/>\n`;
    svg += `<circle cx="${cx + 14}" cy="${pillY + pillH / 2}" r="4" fill="${s.color}"/>\n`;
    svg += `<text x="${cx + 24}" y="${pillY + pillH / 2 + 5}" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}" font-size="14">${escapeSvg(label)}</text>\n`;
    cx += pillW + 10;
  }

  return svg;
}

function estimateStatValueRightEdge(totalTokens: number): number {
  const value = formatCompact(totalTokens);
  return STAT_X + value.length * STAT_VALUE_FONT_SIZE * STAT_VALUE_WIDTH_FACTOR;
}

/** Command badge positioned in the top-right corner. */
function renderCommandBadge(command: string): string {
  const textW = command.length * 9;
  const badgeW = textW + 28;
  const badgeH = 30;
  const x = W - 60 - badgeW;
  const y = ACCENT_H + 30;

  return [
    `<rect x="${x}" y="${y}" width="${badgeW}" height="${badgeH}" rx="${badgeH / 2}" fill="none" stroke="${shareTheme.cardBorder}" stroke-width="1"/>`,
    `<text x="${x + badgeW / 2}" y="${y + badgeH / 2 + 5}" text-anchor="middle" font-size="13" fill="${shareTheme.textMuted}" font-family="${shareTheme.mono}">${escapeSvg(command)}</text>`,
  ].join('\n');
}

function renderGridLines(
  chartLeft: number,
  chartRight: number,
  chartTop: number,
  chartH: number,
  maxY: number,
): string {
  const gridCount = 4;
  let svg = '';

  for (let i = 1; i <= gridCount; i++) {
    const val = (maxY / gridCount) * i;
    const y = chartTop + chartH - (i / gridCount) * chartH;

    svg += `<line x1="${chartLeft}" y1="${y.toFixed(2)}" x2="${chartRight}" y2="${y.toFixed(2)}" stroke="${shareTheme.gridLine}" stroke-width="1" stroke-dasharray="4 4"/>\n`;
    svg += `<text x="${(chartLeft - 12).toFixed(0)}" y="${(y + 4).toFixed(0)}" text-anchor="end" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}" font-size="11">${escapeSvg(formatCompact(val))}</text>\n`;
  }

  return svg;
}

function renderGradientDefs(series: SourceSeries[]): string {
  return series
    .map(
      (s, i) =>
        `<linearGradient id="area-grad-${i}" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0%" stop-color="${s.color}" stop-opacity="0.6"/>
  <stop offset="100%" stop-color="${s.color}" stop-opacity="0.15"/>
</linearGradient>`,
    )
    .join('\n');
}

function renderStackedAreas(
  series: SourceSeries[],
  stacked: number[][],
  periodCount: number,
  toX: (p: number) => number,
  toChartY: (val: number) => number,
  chartBottom: number,
): string {
  if (periodCount < 2 || series.length === 0) return '';

  let svg = '';

  for (let s = series.length - 1; s >= 0; s--) {
    const topPoints: Point[] = Array.from({ length: periodCount }, (_, p) => ({
      x: toX(p),
      y: toChartY(stacked[s][p]),
    }));

    const topPath = catmullRom(topPoints, 0.3, chartBottom);

    let botPath: string;
    if (s === 0) {
      botPath = `L${toX(periodCount - 1).toFixed(2)},${chartBottom} L${toX(0).toFixed(2)},${chartBottom}`;
    } else {
      const botPoints: Point[] = Array.from({ length: periodCount }, (_, p) => ({
        x: toX(p),
        y: toChartY(stacked[s - 1][p]),
      })).reverse();
      botPath = catmullRom(botPoints, 0.3, chartBottom).replace('M', 'L');
    }

    svg += `<path d="${topPath} ${botPath} Z" fill="url(#area-grad-${s})" clip-path="url(#chart-clip)"/>\n`;
  }

  // Top-line stroke with glow
  const totalPoints: Point[] = Array.from({ length: periodCount }, (_, p) => ({
    x: toX(p),
    y: toChartY(stacked[stacked.length - 1][p]),
  }));
  const topLinePath = catmullRom(totalPoints, 0.3, chartBottom);
  svg += `<path d="${topLinePath}" fill="none" stroke="${shareTheme.textPrimary}" stroke-width="2" stroke-opacity="0.5" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#chart-clip)"/>\n`;

  // Dot markers on the top line
  for (const pt of totalPoints) {
    svg += `<circle cx="${pt.x.toFixed(2)}" cy="${pt.y.toFixed(2)}" r="3" fill="${shareTheme.textPrimary}" fill-opacity="0.6" clip-path="url(#chart-clip)"/>\n`;
  }

  return svg;
}

function renderSinglePeriodBars(
  series: SourceSeries[],
  stacked: number[][],
  toX: (p: number) => number,
  toChartY: (val: number) => number,
  chartBottom: number,
  chartW: number,
): string {
  let svg = '';
  const barWidth = Math.min(120, chartW * 0.4);
  const xCenter = toX(0);

  for (let s = series.length - 1; s >= 0; s--) {
    const yTop = toChartY(stacked[s][0]);
    const yBot = s === 0 ? chartBottom : toChartY(stacked[s - 1][0]);
    if (yBot - yTop > 0) {
      svg += `<rect x="${(xCenter - barWidth / 2).toFixed(2)}" y="${yTop.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${(yBot - yTop).toFixed(2)}" fill="url(#area-grad-${s})" rx="4"/>\n`;
    }
  }

  return svg;
}

function renderPeriodLabels(
  periods: string[],
  toX: (p: number) => number,
  chartBottom: number,
): string {
  const periodCount = periods.length;
  const maxLabels = 12;
  const labelStep = periodCount <= maxLabels ? 1 : Math.ceil(periodCount / maxLabels);
  let svg = '';

  for (let p = 0; p < periodCount; p += labelStep) {
    svg += `<text x="${toX(p).toFixed(2)}" y="${(chartBottom + 24).toFixed(0)}" text-anchor="middle" font-size="13" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(periods[p])}</text>\n`;
  }

  return svg;
}

/** Footer strip with branding and period range. */
function renderFooter(periods: string[]): string {
  const y = H - FOOTER_H;
  const lineY = y + 1;
  const textY = y + FOOTER_H / 2 + 5;
  const range =
    periods.length >= 2 ? `${periods[0]} → ${periods[periods.length - 1]}` : (periods[0] ?? '');

  return [
    `<line x1="0" y1="${lineY}" x2="${W}" y2="${lineY}" stroke="${shareTheme.gridLine}" stroke-width="1"/>`,
    `<text x="60" y="${textY}" fill="${shareTheme.textMuted}" font-family="${shareTheme.mono}" font-size="13">llm-usage-metrics</text>`,
    `<text x="${W - 60}" y="${textY}" text-anchor="end" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}" font-size="13">${escapeSvg(range)}</text>`,
  ].join('\n');
}

export function renderUsageShareSvg(
  usageData: UsageDataResult,
  granularity: ReportGranularity,
): string {
  const sourceRows = extractPeriodSourceRows(usageData.rows);
  const grandTotal = extractGrandTotal(usageData.rows);

  const periods = [...new Set(sourceRows.map((r) => r.periodKey))].sort(compareByCodePoint);
  const sources = [...new Set(sourceRows.map((r) => r.source))].sort(compareByCodePoint);
  const allSeries = buildSourceSeries(sourceRows, periods, sources);
  const activeSeries = allSeries.filter((s) => s.total > 0);

  const totalTokens = grandTotal?.totalTokens ?? 0;
  const totalCost = grandTotal?.costUsd;

  const chartLeft = pad.left;
  const chartTop = pad.top;
  const chartRight = W - pad.right;
  const chartBottom = H - pad.bottom;
  const chartW = chartRight - chartLeft;
  const chartH = chartBottom - chartTop;

  const periodCount = periods.length;
  const stacked = buildStackedValues(activeSeries);
  const maxY =
    periodCount > 0 && stacked.length > 0 ? Math.max(1, ...stacked[stacked.length - 1]) * 1.08 : 1;

  const toX = (p: number): number =>
    chartLeft + (periodCount <= 1 ? chartW / 2 : (p / (periodCount - 1)) * chartW);
  const toChartY = (val: number): number => scaleY(val, maxY, chartTop, chartBottom);

  const commandText = `llm-usage ${granularity} --share`;
  const sourcePillsStartX = estimateStatValueRightEdge(totalTokens) + SOURCE_PILLS_STAT_GAP;

  let chartContent: string;
  if (periodCount === 0) {
    chartContent = `<text x="${(W / 2).toFixed(0)}" y="${(H / 2).toFixed(0)}" text-anchor="middle" font-size="20" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">No usage data available</text>`;
  } else if (periodCount === 1) {
    chartContent = renderSinglePeriodBars(
      activeSeries,
      stacked,
      toX,
      toChartY,
      chartBottom,
      chartW,
    );
  } else {
    chartContent = renderStackedAreas(
      activeSeries,
      stacked,
      periodCount,
      toX,
      toChartY,
      chartBottom,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="accent-grad" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#10b981"/>
    <stop offset="100%" stop-color="#06b6d4"/>
  </linearGradient>
  <clipPath id="chart-clip">
    <rect x="${chartLeft}" y="${chartTop - 4}" width="${chartW}" height="${chartH + 8}"/>
  </clipPath>
  ${renderGradientDefs(activeSeries)}
</defs>
<rect width="${W}" height="${H}" fill="${shareTheme.bg}"/>
${renderAccentBar()}
${renderStatColumn(totalTokens, totalCost, activeSeries.length)}
${renderSourcePills(activeSeries, sourcePillsStartX)}
${renderCommandBadge(commandText)}
${renderGridLines(chartLeft, chartRight, chartTop, chartH, maxY)}
${chartContent}
${renderPeriodLabels(periods, toX, chartBottom)}
${renderFooter(periods)}
</svg>`;
}
