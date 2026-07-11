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
  renderShareAccentBar,
  renderShareAccentGradientDef,
  renderShareCommandBadge,
  renderShareFooter,
  scaleY,
  SHARE_SVG_FOOTER_HEIGHT,
  SHARE_SVG_WIDTH,
  shareTheme,
  type Point,
} from './share-svg-theme.js';

const W = SHARE_SVG_WIDTH;
const H_BASE = 620;
const left = 80;
const right = 80;
const statTop = 96;
const legendTop = 158;
const LEGEND_ROW_HEIGHT = 30;
const LEGEND_ITEM_GAP = 28;
const LEGEND_TEXT_WIDTH_FACTOR = 8;
const chartTopBase = 208;
const pad = { bottom: 60 + SHARE_SVG_FOOTER_HEIGHT };

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

function granularityTitle(granularity: ReportGranularity): string {
  return `${granularity.charAt(0).toUpperCase()}${granularity.slice(1)} Usage`;
}

/** Stats row under the title: Tokens, Cost, Sources as label-over-value pairs. */
function renderStatsRow(
  totalTokens: number,
  costUsd: number | undefined,
  sourceCount: number,
): string {
  const stats = [
    { label: 'Tokens', value: formatCompact(totalTokens), x: left },
    { label: 'Cost', value: costUsd === undefined ? '-' : formatUsd(costUsd), x: left + 240 },
    { label: 'Sources', value: String(sourceCount), x: left + 480 },
  ];

  return stats
    .map(
      (stat) =>
        `<text x="${stat.x}" y="${statTop}" font-size="13" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(stat.label)}</text>` +
        `<text x="${stat.x}" y="${statTop + 30}" font-size="26" font-weight="800" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${escapeSvg(stat.value)}</text>`,
    )
    .join('\n');
}

type LegendItem = {
  color: string;
  source: string;
  total: string;
  x: number;
  y: number;
};

/** Wraps legend items (dot + source + total) into as many rows as needed. */
function layoutLegend(series: SourceSeries[]): { items: LegendItem[]; rowCount: number } {
  const items: LegendItem[] = [];
  const rightEdge = W - right;
  let row = 0;
  let cx = left;

  for (const s of series) {
    const total = formatCompact(s.total);
    const width = (s.source.length + total.length + 1) * LEGEND_TEXT_WIDTH_FACTOR + 18;

    if (cx > left && cx + width > rightEdge) {
      row += 1;
      cx = left;
    }

    items.push({
      color: s.color,
      source: s.source,
      total,
      x: cx,
      y: legendTop + row * LEGEND_ROW_HEIGHT,
    });
    cx += width + LEGEND_ITEM_GAP;
  }

  return { items, rowCount: row + 1 };
}

function renderLegend(items: LegendItem[]): string {
  return items
    .map(
      (item) =>
        `<circle data-legend="${escapeSvg(item.source)}" cx="${item.x + 5}" cy="${item.y}" r="5" fill="${item.color}"/>` +
        `<text x="${item.x + 18}" y="${item.y + 5}" font-size="14" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">${escapeSvg(item.source)} <tspan fill="${shareTheme.textMuted}">${escapeSvg(item.total)}</tspan></text>`,
    )
    .join('\n');
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

function formatFooterRange(periods: string[]): string {
  return periods.length >= 2
    ? `${periods[0]} → ${periods[periods.length - 1]}`
    : (periods[0] ?? '');
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

  const commandText = `llm-usage ${granularity} --share`;
  const { items: legendItems, rowCount } = layoutLegend(activeSeries);
  const extraHeight = (rowCount - 1) * LEGEND_ROW_HEIGHT;
  const H = H_BASE + extraHeight;

  const chartLeft = left + 40;
  const chartTop = chartTopBase + extraHeight;
  const chartRight = W - right;
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
  ${renderShareAccentGradientDef()}
  <clipPath id="chart-clip">
    <rect x="${chartLeft}" y="${chartTop - 4}" width="${chartW}" height="${chartH + 8}"/>
  </clipPath>
  ${renderGradientDefs(activeSeries)}
</defs>
<rect width="${W}" height="${H}" fill="${shareTheme.bg}"/>
${renderShareAccentBar()}
<text x="${left}" y="52" font-size="32" font-weight="700" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${escapeSvg(granularityTitle(granularity))}</text>
<text x="${left}" y="76" font-size="15" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">Token usage by source over ${formatFooterRange(periods) || 'the selected window'}</text>
${renderShareCommandBadge(commandText)}
${renderStatsRow(totalTokens, totalCost, activeSeries.length)}
${renderLegend(legendItems)}
${renderGridLines(chartLeft, chartRight, chartTop, chartH, maxY)}
${chartContent}
${renderPeriodLabels(periods, toX, chartBottom)}
${renderShareFooter({ height: H, rightText: formatFooterRange(periods) })}
</svg>`;
}
