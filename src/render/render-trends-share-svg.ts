import { toActivityLevels } from '../aggregate/daily-activity.js';
import type { TrendsDataResult } from '../cli/usage-data-contracts.js';
import type { TrendBucket, TrendsMetric } from '../trends/trends-series.js';
import { formatDuration } from './format-duration.js';
import {
  escapeSvg,
  formatCompact,
  formatUsd,
  renderEmptyState,
  renderShareCard,
  renderStat,
  scaleY,
  SHARE_MARGIN,
  SHARE_WIDTH,
  svgText,
  type ShareTheme,
} from './share-svg-theme.js';

const statsTop = 160;
const statPitch = 268;
const chartLeft = SHARE_MARGIN + 60;
const chartRight = SHARE_WIDTH - SHARE_MARGIN;
const chartTop = 284;
const chartBottom = 500;

function getMetricLabel(metric: TrendsMetric): string {
  if (metric === 'cost') {
    return 'cost';
  }

  return metric === 'active-hours' ? 'active hours' : 'tokens';
}

function formatMetricValue(value: number, metric: TrendsMetric, approximate = false): string {
  const formatted =
    metric === 'cost'
      ? formatUsd(value)
      : metric === 'active-hours'
        ? formatDuration(value)
        : formatCompact(Math.round(value));
  return approximate ? `~${formatted}` : formatted;
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

function renderSummaryStats(data: TrendsDataResult, theme: ShareTheme): string {
  const { metric, totalSeries } = data;
  const minBucket = getMinBucket(totalSeries.buckets);
  const approximate = metric === 'cost' && totalSeries.summary.incomplete;
  const stats = [
    {
      label: 'Total',
      value: formatMetricValue(totalSeries.summary.total, metric, approximate),
      accent: true,
    },
    {
      label: 'Daily average',
      value: formatMetricValue(totalSeries.summary.average, metric, approximate),
    },
    {
      label: 'Peak',
      value: formatMetricValue(totalSeries.summary.peak.value, metric, approximate),
      detail: totalSeries.summary.peak.date,
    },
    {
      label: 'Lowest',
      value: minBucket
        ? formatMetricValue(minBucket.value, metric, minBucket.incomplete === true)
        : '-',
      detail: minBucket?.date,
    },
  ];

  return stats
    .map((stat, index) =>
      renderStat({
        theme,
        x: SHARE_MARGIN + index * statPitch,
        y: statsTop,
        size: 30,
        ...stat,
      }),
    )
    .join('\n');
}

function renderGridLines(scaleMax: number, metric: TrendsMetric, theme: ShareTheme): string {
  const lines: string[] = [];

  for (let step = 1; step <= 3; step += 1) {
    const value = (scaleMax / 3) * step;
    const y = scaleY(value, scaleMax, chartTop, chartBottom);

    lines.push(
      `<line x1="${chartLeft}" y1="${y.toFixed(2)}" x2="${chartRight}" y2="${y.toFixed(2)}" stroke="${theme.line}" stroke-width="1" stroke-dasharray="3 5"/>`,
      svgText(chartLeft - 10, y + 4, formatMetricValue(value, metric), {
        size: 12,
        fill: theme.textMuted,
        mono: true,
        anchor: 'end',
      }),
    );
  }

  lines.push(
    `<line x1="${chartLeft}" y1="${chartBottom}" x2="${chartRight}" y2="${chartBottom}" stroke="${theme.line}" stroke-width="1"/>`,
  );

  return lines.join('\n');
}

/** One bar per day, shaded by quartile like the activity heatmap; days without data are faint. */
function renderBars(buckets: readonly TrendBucket[], scaleMax: number, theme: ShareTheme): string {
  const slot = (chartRight - chartLeft) / buckets.length;
  const barWidth = Math.max(1, Math.min(40, slot * 0.7));
  const levels = toActivityLevels(buckets.map((bucket) => bucket.value));

  return buckets
    .map((bucket, index) => {
      const x = chartLeft + index * slot + (slot - barWidth) / 2;
      const yTop = scaleY(bucket.value, scaleMax, chartTop, chartBottom);
      const opacity = bucket.observed ? '' : ' fill-opacity="0.4"';

      return `<rect data-date="${escapeSvg(bucket.date)}" x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${(chartBottom - yTop).toFixed(2)}" rx="2" fill="${theme.heat[Math.max(1, levels[index])]}"${opacity}/>`;
    })
    .join('\n');
}

function renderDateLabels(buckets: readonly TrendBucket[], theme: ShareTheme): string {
  const slot = (chartRight - chartLeft) / buckets.length;
  const indexes = [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])];

  return indexes
    .map((index) => {
      // The outer labels align to the chart edges so they never leave the card.
      const anchor = index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle';
      const x =
        anchor === 'start'
          ? chartLeft
          : anchor === 'end'
            ? chartRight
            : chartLeft + index * slot + slot / 2;

      return svgText(x, chartBottom + 26, buckets[index].date, {
        size: 13,
        fill: theme.textMuted,
        anchor,
      });
    })
    .join('\n');
}

export function renderTrendsShareSvg(data: TrendsDataResult, theme: ShareTheme): string {
  const buckets = data.totalSeries.buckets;
  const scaleMax = Math.max(1, ...buckets.map((bucket) => bucket.value)) * 1.08;
  const source = data.totalSeries.source === 'combined' ? 'all sources' : data.totalSeries.source;
  const body =
    buckets.length === 0
      ? renderEmptyState(theme, 'No usage in this window')
      : [
          renderSummaryStats(data, theme),
          renderGridLines(scaleMax, data.metric, theme),
          renderBars(buckets, scaleMax, theme),
          renderDateLabels(buckets, theme),
        ].join('\n');

  return renderShareCard({
    theme,
    title: `Daily ${getMetricLabel(data.metric)}`,
    subtitle: `${buckets.length} ${buckets.length === 1 ? 'day' : 'days'} of ${source}`,
    command: 'llm-usage trends --share',
    footnote: getDateRangeLabel(data),
    body,
  });
}
