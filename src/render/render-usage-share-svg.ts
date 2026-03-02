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
const pad = { top: 130, right: 60, bottom: 60, left: 60 };

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

function getCommandText(granularity: ReportGranularity): string {
  return `llm-usage ${granularity} --share`;
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

    svg += `<line x1="${chartLeft}" y1="${y.toFixed(2)}" x2="${chartRight}" y2="${y.toFixed(2)}" stroke="${shareTheme.gridLine}" stroke-width="1"/>\n`;
    svg += `<text x="${(chartRight + 8).toFixed(0)}" y="${(y + 4).toFixed(0)}" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}" font-size="11">${escapeSvg(formatCompact(val))}</text>\n`;
  }

  return svg;
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

    svg += `<path d="${topPath} ${botPath} Z" fill="${series[s].color}" opacity="0.55" clip-path="url(#chart-clip)"/>\n`;
  }

  // Outline for the total stack
  const totalPoints: Point[] = Array.from({ length: periodCount }, (_, p) => ({
    x: toX(p),
    y: toChartY(stacked[stacked.length - 1][p]),
  }));
  svg += `<path d="${catmullRom(totalPoints, 0.3, chartBottom)}" fill="none" stroke="${shareTheme.textPrimary}" stroke-width="1.5" stroke-opacity="0.4" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#chart-clip)"/>\n`;

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
      svg += `<rect x="${(xCenter - barWidth / 2).toFixed(2)}" y="${yTop.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${(yBot - yTop).toFixed(2)}" fill="${series[s].color}" opacity="0.55" rx="4"/>\n`;
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
    svg += `<text x="${toX(p).toFixed(2)}" y="${(chartBottom + 28).toFixed(0)}" text-anchor="middle" font-size="13" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(periods[p])}</text>\n`;
  }

  return svg;
}

function renderLegend(series: SourceSeries[], vcenter: number): string {
  const legendItemW = 145;
  const legendStartX = pad.left + 8;
  let svg = '';

  for (let i = 0; i < series.length; i++) {
    const x = legendStartX + i * legendItemW;
    const s = series[i];

    svg += `<rect x="${x}" y="${(vcenter - 14).toFixed(0)}" width="14" height="14" rx="3" fill="${s.color}" opacity="0.8"/>`;
    svg += `<text x="${x + 20}" y="${vcenter.toFixed(0)}" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}" font-size="17">${escapeSvg(s.source)}</text>`;
    svg += `<text x="${x + 20}" y="${(vcenter + 18).toFixed(0)}" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}" font-size="15">${escapeSvg(formatCompact(s.total))}</text>\n`;
  }

  return svg;
}

function renderCommandBadge(
  command: string,
  legendEndX: number,
  totalStartX: number,
  vcenter: number,
): string {
  const midX = (legendEndX + totalStartX) / 2;
  const textWidth = command.length * 10;
  const badgeW = textWidth + 28;
  const badgeH = 34;

  return [
    `<rect x="${(midX - badgeW / 2).toFixed(0)}" y="${(vcenter - badgeH / 2 - 2).toFixed(0)}" width="${badgeW.toFixed(0)}" height="${badgeH.toFixed(0)}" rx="8" fill="${shareTheme.cardBg}" stroke="${shareTheme.cardBorder}"/>`,
    `<text x="${midX.toFixed(0)}" y="${(vcenter + 5).toFixed(0)}" text-anchor="middle" font-size="15" fill="${shareTheme.textSecondary}" font-family="${shareTheme.mono}">${escapeSvg(command)}</text>`,
  ].join('\n');
}

function renderTotals(totalTokens: number, costUsd: number | undefined, vcenter: number): string {
  let svg = '';
  const xRight = W - pad.right;

  svg += `<text x="${xRight}" y="${(vcenter + 6).toFixed(0)}" text-anchor="end" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}" font-size="48" font-weight="800">${escapeSvg(formatCompact(totalTokens))}</text>\n`;
  svg += `<text x="${xRight}" y="${(vcenter + 26).toFixed(0)}" text-anchor="end" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}" font-size="16" letter-spacing="2" font-weight="600">TOKENS</text>\n`;

  if (costUsd !== undefined) {
    svg += `<text x="${xRight}" y="${(vcenter + 48).toFixed(0)}" text-anchor="end" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}" font-size="18">${escapeSvg(formatUsd(costUsd))}</text>\n`;
  }

  return svg;
}

export function renderUsageShareSvg(
  usageData: UsageDataResult,
  granularity: ReportGranularity,
): string {
  const sourceRows = extractPeriodSourceRows(usageData.rows);
  const grandTotal = extractGrandTotal(usageData.rows);

  const periods = [...new Set(sourceRows.map((r) => r.periodKey))].sort(compareByCodePoint);
  const sources = [...new Set(sourceRows.map((r) => r.source))];
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

  const vcenter = pad.top / 2;
  const legendItemW = 145;
  const legendEndX = pad.left + 8 + activeSeries.length * legendItemW;
  const totalStartX = W - pad.right - 160;

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
  <clipPath id="chart-clip">
    <rect x="${chartLeft}" y="${chartTop - 4}" width="${chartW}" height="${chartH + 8}"/>
  </clipPath>
</defs>
<rect width="${W}" height="${H}" fill="${shareTheme.bg}"/>
${renderTotals(totalTokens, totalCost, vcenter)}
${renderCommandBadge(getCommandText(granularity), legendEndX, totalStartX, vcenter)}
${renderLegend(activeSeries, vcenter)}
${renderGridLines(chartLeft, chartRight, chartTop, chartH, maxY)}
${chartContent}
${renderPeriodLabels(periods, toX, chartBottom)}
</svg>`;
}
