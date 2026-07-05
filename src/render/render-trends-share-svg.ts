import type { TrendsDataResult } from '../cli/usage-data-contracts.js';
import type { TrendBucket, TrendsMetric } from '../trends/trends-series.js';
import {
  catmullRom,
  escapeSvg,
  formatCompact,
  formatUsd,
  renderShareAccentBar,
  renderShareFooter,
  scaleY,
  SHARE_SVG_FOOTER_HEIGHT,
  SHARE_SVG_WIDTH,
  shareTheme,
  type Point,
} from './share-svg-theme.js';

const W = SHARE_SVG_WIDTH;
const H = 560;
const pad = { top: 165, right: 110, bottom: 70 + SHARE_SVG_FOOTER_HEIGHT, left: 120 };

const chartColors: Record<TrendsMetric, string> = {
  cost: '#10b981',
  tokens: '#06b6d4',
};

function getMetricLabel(metric: TrendsMetric): string {
  return metric === 'cost' ? 'Cost' : 'Token Usage';
}

function formatMetricValue(value: number, metric: TrendsMetric, approximate = false): string {
  const formatted = metric === 'cost' ? formatUsd(value) : formatCompact(Math.round(value));
  return approximate ? `~${formatted}` : formatted;
}

function getDayLabel(bucketCount: number): string {
  return bucketCount === 1 ? 'day' : 'days';
}

function getDateRangeLabel(data: TrendsDataResult): string {
  return data.dateRange.from === data.dateRange.to
    ? data.dateRange.from
    : `${data.dateRange.from} to ${data.dateRange.to}`;
}

function getMinBucket(buckets: readonly TrendBucket[]): TrendBucket | undefined {
  return buckets.reduce<TrendBucket | undefined>(
    (minBucket, bucket) =>
      minBucket === undefined || bucket.value < minBucket.value ? bucket : minBucket,
    undefined,
  );
}

function renderSummaryStats(data: TrendsDataResult): string {
  const { metric, totalSeries } = data;
  const minBucket = getMinBucket(totalSeries.buckets);
  const approximate = metric === 'cost' && totalSeries.summary.incomplete;
  const stats = [
    {
      label: 'Total',
      value: formatMetricValue(totalSeries.summary.total, metric, approximate),
      x: pad.left,
    },
    {
      label: 'Avg / Day',
      value: formatMetricValue(totalSeries.summary.average, metric, approximate),
      x: 350,
    },
    {
      label: 'Peak',
      value: `${formatMetricValue(totalSeries.summary.peak.value, metric, approximate)} ${totalSeries.summary.peak.date}`,
      x: 580,
    },
    {
      label: 'Min',
      value: minBucket
        ? `${formatMetricValue(minBucket.value, metric, minBucket.incomplete === true)} ${minBucket.date}`
        : '-',
      x: 910,
    },
  ];

  return stats
    .map(
      (stat) =>
        `<text x="${stat.x}" y="92" font-size="13" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(stat.label)}</text>` +
        `<text x="${stat.x}" y="118" font-size="20" font-weight="700" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${escapeSvg(stat.value)}</text>`,
    )
    .join('\n');
}

function renderGridLines(
  chartLeft: number,
  chartRight: number,
  chartTop: number,
  chartBottom: number,
  scaleMax: number,
  metric: TrendsMetric,
): string {
  const gridCount = 4;
  const lines: string[] = [];

  for (let index = 0; index <= gridCount; index++) {
    const value = (scaleMax / gridCount) * (gridCount - index);
    const y = chartTop + ((chartBottom - chartTop) / gridCount) * index;
    const dash = index === gridCount ? '' : ' stroke-dasharray="4 4"';

    lines.push(
      `<line x1="${chartLeft}" y1="${y.toFixed(2)}" x2="${chartRight}" y2="${y.toFixed(2)}" stroke="${shareTheme.gridLine}" stroke-width="1"${dash}/>`,
    );
    lines.push(
      `<text x="${(chartLeft - 14).toFixed(0)}" y="${(y + 4).toFixed(0)}" text-anchor="end" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}" font-size="11">${escapeSvg(formatMetricValue(value, metric))}</text>`,
    );
  }

  return lines.join('\n');
}

function renderDateLabels(
  buckets: readonly TrendBucket[],
  toX: (index: number) => number,
  y: number,
): string {
  if (buckets.length === 0) {
    return '';
  }

  const labelIndexes = [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])];

  return labelIndexes
    .map((index) => {
      const anchor = index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle';
      return `<text x="${toX(index).toFixed(2)}" y="${y}" text-anchor="${anchor}" font-size="13" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(buckets[index]?.date ?? '')}</text>`;
    })
    .join('\n');
}

function renderTrendShape(
  buckets: readonly TrendBucket[],
  points: readonly Point[],
  color: string,
  chartBottom: number,
): string {
  if (points.length === 0) {
    return '';
  }

  if (points.length === 1) {
    const point = points[0];
    return `<circle data-series="combined" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="6" fill="${color}"/>`;
  }

  const linePath = catmullRom([...points], 0.3, chartBottom);
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const areaPath = `${linePath} L${lastPoint.x.toFixed(2)},${chartBottom} L${firstPoint.x.toFixed(2)},${chartBottom} Z`;
  const dots = points
    .map((point, index) => {
      const opacity = buckets[index]?.observed ? '0.95' : '0.35';
      return `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="4" fill="${color}" fill-opacity="${opacity}" clip-path="url(#chart-clip)"/>`;
    })
    .join('\n');

  return [
    `<path d="${areaPath}" fill="url(#trend-area-grad)" clip-path="url(#chart-clip)"/>`,
    `<path data-series="combined" d="${linePath}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#chart-clip)"/>`,
    dots,
  ].join('\n');
}

export function renderTrendsShareSvg(data: TrendsDataResult): string {
  const buckets = data.totalSeries.buckets;
  const chartLeft = pad.left;
  const chartTop = pad.top;
  const chartRight = W - pad.right;
  const chartBottom = H - pad.bottom;
  const chartW = chartRight - chartLeft;
  const chartH = chartBottom - chartTop;
  const bucketCount = buckets.length;
  const color = chartColors[data.metric];
  const scaleMax = Math.max(1, ...buckets.map((bucket) => bucket.value)) * 1.08;
  const toX = (index: number): number =>
    chartLeft + (bucketCount <= 1 ? chartW / 2 : (index / (bucketCount - 1)) * chartW);
  const points = buckets.map((bucket, index) => ({
    x: toX(index),
    y: scaleY(bucket.value, scaleMax, chartTop, chartBottom),
  }));
  const commandText = 'llm-usage trends --share';
  const badgeW = commandText.length * 9.5 + 28;
  const badgeX = W - pad.right - badgeW;
  const title = `Daily ${getMetricLabel(data.metric)} Trend`;
  const subtitle = `${bucketCount} ${getDayLabel(bucketCount)} · ${getDateRangeLabel(data)}`;
  const seriesLabel = `Series: ${data.totalSeries.source}`;
  const chartContent =
    bucketCount === 0
      ? `<text x="${(W / 2).toFixed(0)}" y="${(H / 2).toFixed(0)}" text-anchor="middle" font-size="20" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">No trend data available</text>`
      : renderTrendShape(buckets, points, color, chartBottom);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="accent-grad" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#10b981"/>
    <stop offset="100%" stop-color="#06b6d4"/>
  </linearGradient>
  <linearGradient id="trend-area-grad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${color}" stop-opacity="0.42"/>
    <stop offset="100%" stop-color="${color}" stop-opacity="0.08"/>
  </linearGradient>
  <clipPath id="chart-clip">
    <rect x="${chartLeft}" y="${chartTop - 6}" width="${chartW}" height="${chartH + 12}"/>
  </clipPath>
</defs>
<rect width="${W}" height="${H}" fill="${shareTheme.bg}"/>
${renderShareAccentBar()}
<text x="${pad.left}" y="52" font-size="32" font-weight="700" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${escapeSvg(title)}</text>
<text x="${pad.left}" y="78" font-size="15" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">${escapeSvg(subtitle)}</text>
<rect x="${badgeX.toFixed(0)}" y="30" width="${badgeW.toFixed(0)}" height="34" rx="17" fill="none" stroke="${shareTheme.cardBorder}"/>
<text x="${(badgeX + badgeW / 2).toFixed(0)}" y="52" text-anchor="middle" font-size="14" fill="${shareTheme.textMuted}" font-family="${shareTheme.mono}">${escapeSvg(commandText)}</text>
${renderSummaryStats(data)}
<text x="${chartLeft}" y="${(chartTop - 22).toFixed(0)}" font-size="13" fill="${color}" font-family="${shareTheme.font}">${escapeSvg(seriesLabel)}</text>
${renderGridLines(chartLeft, chartRight, chartTop, chartBottom, scaleMax, data.metric)}
${chartContent}
${renderDateLabels(buckets, toX, chartBottom + 30)}
${renderShareFooter({ height: H, rightText: getDateRangeLabel(data) })}
</svg>`;
}
