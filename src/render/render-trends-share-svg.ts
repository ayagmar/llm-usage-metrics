import type { TrendsDataResult } from '../cli/usage-data-contracts.js';
import type { TrendBucket, TrendsMetric } from '../trends/trends-series.js';
import {
  catmullRom,
  escapeSvg,
  formatCompact,
  formatUsd,
  renderShareCommandBadge,
  renderShareDocument,
  scaleY,
  SHARE_SVG_FOOTER_HEIGHT,
  SHARE_SVG_WIDTH,
  shareTheme,
  type Point,
} from './share-svg-theme.js';

const W = SHARE_SVG_WIDTH;
const H = 580;
const pad = { top: 180, right: 80, bottom: 70 + SHARE_SVG_FOOTER_HEIGHT, left: 120 };

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
      x: pad.left + 260,
    },
    {
      label: 'Peak',
      value: formatMetricValue(totalSeries.summary.peak.value, metric, approximate),
      date: totalSeries.summary.peak.date,
      x: pad.left + 520,
    },
    {
      label: 'Min',
      value: minBucket
        ? formatMetricValue(minBucket.value, metric, minBucket.incomplete === true)
        : '-',
      date: minBucket?.date,
      x: pad.left + 780,
    },
  ];

  return stats
    .map((stat) => {
      const lines = [
        `<text x="${stat.x}" y="92" font-size="13" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(stat.label)}</text>`,
        `<text x="${stat.x}" y="118" font-size="22" font-weight="700" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${escapeSvg(stat.value)}</text>`,
      ];

      if (stat.date !== undefined) {
        lines.push(
          `<text x="${stat.x}" y="138" font-size="12" fill="${shareTheme.textMuted}" font-family="${shareTheme.font}">${escapeSvg(stat.date)}</text>`,
        );
      }

      return lines.join('\n');
    })
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
  const title = `Daily ${getMetricLabel(data.metric)} Trend`;
  const subtitle = `${bucketCount} ${getDayLabel(bucketCount)} - ${getDateRangeLabel(data)} · ${data.totalSeries.source}`;
  const peakIndex = buckets.findIndex(
    (bucket) => bucket.date === data.totalSeries.summary.peak.date,
  );
  const peakPoint = peakIndex >= 0 ? points[peakIndex] : undefined;
  const peakMarker =
    bucketCount > 1 && peakPoint
      ? `<circle data-peak="${escapeSvg(data.totalSeries.summary.peak.date)}" cx="${peakPoint.x.toFixed(2)}" cy="${peakPoint.y.toFixed(2)}" r="9" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.7"/>`
      : '';
  const chartContent =
    bucketCount === 0
      ? `<text x="${(W / 2).toFixed(0)}" y="${(H / 2).toFixed(0)}" text-anchor="middle" font-size="20" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">No trend data available</text>`
      : renderTrendShape(buckets, points, color, chartBottom);

  const extraDefs = `<linearGradient id="trend-area-grad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${color}" stop-opacity="0.42"/>
    <stop offset="100%" stop-color="${color}" stop-opacity="0.08"/>
  </linearGradient>
  <clipPath id="chart-clip">
    <rect x="${chartLeft}" y="${chartTop - 6}" width="${chartW}" height="${chartH + 12}"/>
  </clipPath>`;
  const body = `<text x="${pad.left}" y="52" font-size="32" font-weight="700" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${escapeSvg(title)}</text>
<text x="${pad.left}" y="78" font-size="15" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">${escapeSvg(subtitle)}</text>
${renderShareCommandBadge(commandText)}
${renderSummaryStats(data)}
${renderGridLines(chartLeft, chartRight, chartTop, chartBottom, scaleMax, data.metric)}
${chartContent}
${peakMarker}
${renderDateLabels(buckets, toX, chartBottom + 30)}`;

  return renderShareDocument({
    height: H,
    extraDefs,
    body,
    footerRightText: getDateRangeLabel(data),
  });
}
