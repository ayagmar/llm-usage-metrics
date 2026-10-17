import { markdownTable } from 'markdown-table';
import pc from 'picocolors';

import {
  SPIKE_BASELINE_DAYS,
  SPIKE_MIN_COST_USD,
  SPIKE_MIN_MULTIPLE,
} from '../aggregate/spend-spikes.js';
import type { TrendsReportData } from '../cli/build-trends-data.js';
import type { TrendBucket, TrendSeries, TrendsMetric } from '../trends/trends-series.js';
import { formatDuration } from './format-duration.js';
import { pluralize } from './format-number.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import {
  padEndVisible,
  padStartVisible,
  resolveTtyColumns,
  visibleWidth,
} from './table-text-layout.js';
import { renderReportJson } from './report-json.js';
import { formatAbbreviatedTokenCount } from './row-cells.js';
import {
  downsamplePeaks,
  renderSparkline,
  SPARKLINE_GLYPHS,
  SPARKLINE_TOP_LEVEL,
  sparklineLevel,
} from './sparkline.js';

export type TrendsReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderTrendsReportOptions = {
  useColor?: boolean;
  terminalWidth?: number;
};

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const minimumCompressedEmptyEdgeDays = 7;

function resolveTerminalWidth(override: number | undefined): number | undefined {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }

  return resolveTtyColumns(process.stdout);
}

function formatMetricValue(value: number, metric: TrendsMetric, approximate = false): string {
  if (metric === 'cost') {
    const formatted = usdFormatter.format(value);
    return approximate ? `~${formatted}` : formatted;
  }

  if (metric === 'active-hours') {
    return formatDuration(value);
  }

  return formatAbbreviatedTokenCount(value);
}

function formatAxisValue(value: number, metric: TrendsMetric): string {
  if (metric === 'cost') {
    return usdFormatter.format(value);
  }

  if (metric === 'active-hours') {
    return formatDuration(value);
  }

  return formatAbbreviatedTokenCount(value);
}

/**
 * The step between token ticks: the smallest round step (1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8
 * × 10^n, and at least 1) that covers `rawStep`, so every token tick is a whole number.
 */
function resolveTokenTickStep(rawStep: number): number {
  if (rawStep <= 1) {
    return 1;
  }

  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  // 1.5 and 2.5 make whole steps only from 10 up.
  const multipliers =
    magnitude >= 10 ? [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] : [1, 2, 3, 4, 5, 6, 8, 10];
  const multiplier = multipliers.find((candidate) => magnitude * candidate >= rawStep) ?? 10;

  return magnitude * multiplier;
}

function formatDateLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(parsed);
}

function getMetricTitleLabel(metric: TrendsMetric): string {
  if (metric === 'cost') {
    return 'Cost';
  }

  return metric === 'active-hours' ? 'Active Hours' : 'Token Usage';
}

function getReportTitle(trendsData: TrendsReportData): string {
  const metricLabel = getMetricTitleLabel(trendsData.metric);
  const bucketCount = trendsData.totalSeries.buckets.length;
  const dayLabel = bucketCount === 1 ? 'day' : 'days';
  const splitSuffix =
    trendsData.sourceSeries && trendsData.sourceSeries.length > 0
      ? ' by Source'
      : trendsData.projectSeries && trendsData.projectSeries.length > 0
        ? ' by Project'
        : '';

  return `Daily ${metricLabel} Trend${splitSuffix} (${bucketCount} ${dayLabel})`;
}

function renderCombinedChartCell(barLevel: number, rowIndex: number, rowCount: number): string {
  const rowBaseLevel = (rowCount - rowIndex - 1) * SPARKLINE_TOP_LEVEL;
  const cellLevel = Math.max(0, Math.min(SPARKLINE_TOP_LEVEL, barLevel - rowBaseLevel));

  return SPARKLINE_GLYPHS[cellLevel];
}

function isApproximatePeak(series: TrendSeries, metric: TrendsMetric): boolean {
  if (metric !== 'cost' || series.summary.observedDayCount === 0) {
    return false;
  }

  return (
    series.buckets.find((bucket) => bucket.observed && bucket.date === series.summary.peak.date)
      ?.incomplete === true
  );
}

function shouldShowNoResolvedCostDataNote(trendsData: TrendsReportData): boolean {
  return (
    trendsData.metric === 'cost' &&
    trendsData.totalSeries.summary.observedDayCount > 0 &&
    trendsData.totalSeries.buckets
      .filter((bucket) => bucket.observed)
      .every((bucket) => bucket.incomplete === true && bucket.value === 0)
  );
}

function renderSummary(series: TrendSeries, metric: TrendsMetric): string {
  const summaryApproximate = metric === 'cost' && series.summary.incomplete;
  const items = [
    `Total: ${formatMetricValue(series.summary.total, metric, summaryApproximate)}`,
    `Avg: ${formatMetricValue(series.summary.average, metric, summaryApproximate)}/day`,
  ];

  if (series.summary.observedDayCount > 0) {
    const peakDateLabel = formatDateLabel(series.summary.peak.date);
    items.push(
      `Peak: ${formatMetricValue(series.summary.peak.value, metric, isApproximatePeak(series, metric))} (${peakDateLabel})`,
    );
  }

  return items.join('  |  ');
}

/** The legend of the chart's spend spikes, or undefined without any. */
function formatSpikeLine(
  series: TrendSeries,
  formatDate: (date: string) => string,
): string | undefined {
  const spikes = series.buckets.filter((bucket) => bucket.spike === true);

  if (spikes.length === 0) {
    return undefined;
  }

  const days = spikes.map(
    (bucket) =>
      `${formatDate(bucket.date)} ${formatMetricValue(bucket.value, 'cost', bucket.incomplete)}`,
  );

  return `Spend spikes (${SPIKE_MIN_MULTIPLE}× the ${SPIKE_BASELINE_DAYS}-day median or more, ${usdFormatter.format(SPIKE_MIN_COST_USD)} minimum): ${days.join(', ')}`;
}

/** The totals line, then the spike legend when the chart has spikes. */
function renderSummaryLines(trendsData: TrendsReportData): string[] {
  const spikeLine = formatSpikeLine(trendsData.totalSeries, formatDateLabel);

  return [
    renderSummary(trendsData.totalSeries, trendsData.metric),
    ...(spikeLine === undefined ? [] : [spikeLine]),
  ];
}

function renderSummaryOnly(
  trendsData: TrendsReportData,
  options: { useColor: boolean; narrowNote: boolean },
): string {
  const lines = [
    renderReportHeader({
      title: getReportTitle(trendsData),
      useColor: options.useColor,
    }),
    '',
  ];

  if (options.narrowNote) {
    lines.push('Terminal is too narrow for chart rendering. Widen the terminal or use --json.');
    lines.push('');
  }

  if (trendsData.totalSeries.summary.observedDayCount === 0) {
    lines.push(formatNoUsageMessage(false, 'for the selected date range'));
    return lines.join('\n');
  }

  if (shouldShowNoResolvedCostDataNote(trendsData)) {
    lines.push(
      'No resolved cost data for the selected range; use pricing or switch to --metric tokens.',
    );
    lines.push('');
  }

  lines.push(...renderSummaryLines(trendsData));

  return lines.join('\n');
}

function isInactiveEdgeBucket(bucket: TrendBucket): boolean {
  return !bucket.observed && bucket.value === 0 && bucket.incomplete !== true;
}

function findLeadingInactiveBucketCount(buckets: readonly TrendBucket[]): number {
  let count = 0;

  while (count < buckets.length && isInactiveEdgeBucket(buckets[count])) {
    count += 1;
  }

  return count;
}

function findTrailingInactiveBucketCount(buckets: readonly TrendBucket[]): number {
  let count = 0;

  while (count < buckets.length && isInactiveEdgeBucket(buckets[buckets.length - 1 - count])) {
    count += 1;
  }

  return count;
}

function formatCompressedEdgeNote(
  count: number,
  startDate: string,
  endDate: string,
  position: 'before' | 'after',
): string {
  const rangeLabel =
    startDate === endDate
      ? formatDateLabel(startDate)
      : `${formatDateLabel(startDate)}-${formatDateLabel(endDate)}`;
  const activityLabel = position === 'before' ? 'before first activity' : 'after last activity';

  return `Compressed ${pluralize(count, 'empty day')} ${activityLabel} (${rangeLabel}).`;
}

function getCombinedChartView(series: TrendSeries): {
  chartSeries: TrendSeries;
  notes: string[];
} {
  if (series.buckets.length === 0) {
    return {
      chartSeries: series,
      notes: [],
    };
  }

  const leadingInactiveBucketCount = findLeadingInactiveBucketCount(series.buckets);
  const trailingInactiveBucketCount = findTrailingInactiveBucketCount(series.buckets);
  const notes: string[] = [];
  let startIndex = 0;
  let endIndex = series.buckets.length - 1;

  if (
    leadingInactiveBucketCount >= minimumCompressedEmptyEdgeDays &&
    leadingInactiveBucketCount < series.buckets.length
  ) {
    const firstCompressedBucket = series.buckets[0];
    const lastCompressedBucket = series.buckets[leadingInactiveBucketCount - 1];
    notes.push(
      formatCompressedEdgeNote(
        leadingInactiveBucketCount,
        firstCompressedBucket.date,
        lastCompressedBucket.date,
        'before',
      ),
    );
    startIndex = leadingInactiveBucketCount;
  }

  if (
    trailingInactiveBucketCount >= minimumCompressedEmptyEdgeDays &&
    trailingInactiveBucketCount < series.buckets.length - startIndex
  ) {
    const firstCompressedBucket =
      series.buckets[series.buckets.length - trailingInactiveBucketCount];
    const lastCompressedBucket = series.buckets[series.buckets.length - 1];
    notes.push(
      formatCompressedEdgeNote(
        trailingInactiveBucketCount,
        firstCompressedBucket.date,
        lastCompressedBucket.date,
        'after',
      ),
    );
    endIndex = series.buckets.length - trailingInactiveBucketCount - 1;
  }

  return {
    chartSeries:
      notes.length === 0
        ? series
        : {
            ...series,
            buckets: series.buckets.slice(startIndex, endIndex + 1),
          },
    notes,
  };
}

function renderCombinedChart(
  series: TrendSeries,
  metric: TrendsMetric,
  plotWidth: number,
): string[] {
  const columns = downsamplePeaks(
    series.buckets.map((bucket) => bucket.value),
    plotWidth,
  );
  const lines: string[] = [];
  const chartRowCount = 4;
  const peakValue = Math.max(0, ...columns);
  // Token counts are whole, so the token axis tops out at a round multiple of its tick step.
  const maxValue =
    metric === 'tokens' && peakValue > 0
      ? resolveTokenTickStep(peakValue / chartRowCount) * chartRowCount
      : peakValue;
  const tickValues = Array.from({ length: chartRowCount + 1 }, (_, index) => {
    const inverseIndex = chartRowCount - index;
    return maxValue === 0 ? 0 : (maxValue * inverseIndex) / chartRowCount;
  });
  const labelWidth = tickValues.reduce(
    (maxWidth, value) => Math.max(maxWidth, visibleWidth(formatAxisValue(value, metric))),
    0,
  );
  const barLevels = columns.map((value) =>
    sparklineLevel(value, maxValue, chartRowCount * SPARKLINE_TOP_LEVEL),
  );

  tickValues.forEach((tickValue, tickIndex) => {
    if (tickIndex === tickValues.length - 1) {
      lines.push(
        `${padStartVisible(formatAxisValue(0, metric), labelWidth)} ┼${'─'.repeat(columns.length)}`,
      );
      return;
    }

    const glyphs = barLevels
      .map((barLevel) => renderCombinedChartCell(barLevel, tickIndex, chartRowCount))
      .join('');

    lines.push(
      `${padStartVisible(formatAxisValue(tickValue, metric), labelWidth)} ┤${glyphs}`.trimEnd(),
    );
  });

  const startLabel = formatDateLabel(series.buckets[0]?.date ?? '');
  const endLabel = formatDateLabel(series.buckets.at(-1)?.date ?? '');
  const middleLabel =
    series.buckets.length > 2
      ? formatDateLabel(series.buckets[Math.floor(series.buckets.length / 2)]?.date ?? '')
      : '';
  const xAxisWidth = Math.max(
    columns.length,
    visibleWidth(startLabel) + visibleWidth(endLabel) + 1,
  );
  let xAxisLine = ` ${' '.repeat(labelWidth)}  ${startLabel}`;

  if (
    middleLabel &&
    xAxisWidth > visibleWidth(startLabel) + visibleWidth(middleLabel) + visibleWidth(endLabel) + 4
  ) {
    const middlePadding = Math.max(
      1,
      Math.floor(
        (xAxisWidth -
          visibleWidth(startLabel) -
          visibleWidth(middleLabel) -
          visibleWidth(endLabel)) /
          2,
      ),
    );
    xAxisLine += `${' '.repeat(middlePadding)}${middleLabel}`;
  }

  const trailingPadding = Math.max(
    1,
    xAxisWidth - visibleWidth(xAxisLine) + labelWidth + 2 - visibleWidth(endLabel),
  );
  xAxisLine += `${' '.repeat(trailingPadding)}${endLabel}`;
  lines.push(xAxisLine);

  return lines;
}

/** A series drawn as one sparkline row, under its source id or project label. */
type LabelledSeries = Pick<TrendSeries, 'buckets' | 'summary'> & { label: string };

/** The per-source or per-project series to draw one row each, if the report is split. */
function getSplitSeries(trendsData: TrendsReportData): LabelledSeries[] {
  if (trendsData.sourceSeries && trendsData.sourceSeries.length > 0) {
    return trendsData.sourceSeries.map((series) => ({ ...series, label: series.source }));
  }

  return (trendsData.projectSeries ?? []).map((series) => ({ ...series, label: series.project }));
}

function renderSplitLines(
  sourceSeries: LabelledSeries[],
  metric: TrendsMetric,
  width: number,
): string[] {
  const labelWidth = sourceSeries.reduce(
    (maxWidth, series) => Math.max(maxWidth, visibleWidth(series.label)),
    'Source'.length,
  );
  const totalWidth = sourceSeries.reduce(
    (maxWidth, series) =>
      Math.max(
        maxWidth,
        visibleWidth(formatMetricValue(series.summary.total, metric, series.summary.incomplete)),
      ),
    0,
  );
  const sparklineWidth = Math.max(8, width - labelWidth - totalWidth - 4);

  return sourceSeries.map((series) => {
    const sparkline = renderSparkline(
      series.buckets.map((bucket) => bucket.value),
      sparklineWidth,
    );
    const total = formatMetricValue(series.summary.total, metric, series.summary.incomplete);

    return `${padEndVisible(series.label, labelWidth)} ${sparkline} ${padStartVisible(total, totalWidth)}`;
  });
}

function renderTerminalTrendsReport(
  trendsData: TrendsReportData,
  options: RenderTrendsReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const terminalWidth = resolveTerminalWidth(options.terminalWidth);
  const accent = trendsData.metric === 'cost' ? pc.green : pc.cyan;
  const minimumChartWidth = 40;

  const isEmpty = trendsData.totalSeries.summary.observedDayCount === 0;

  if (isEmpty || (terminalWidth !== undefined && terminalWidth < minimumChartWidth)) {
    return renderSummaryOnly(trendsData, { useColor, narrowNote: !isEmpty });
  }

  const lines = [
    renderReportHeader({
      title: getReportTitle(trendsData),
      useColor,
    }),
    '',
  ];

  if (shouldShowNoResolvedCostDataNote(trendsData)) {
    lines.push(
      'No resolved cost data for the selected range; use pricing or switch to --metric tokens.',
    );
    lines.push('');
  }

  const splitSeries = getSplitSeries(trendsData);

  if (splitSeries.length > 0) {
    lines.push(...renderSplitLines(splitSeries, trendsData.metric, terminalWidth ?? 80));
  } else {
    const chartView = getCombinedChartView(trendsData.totalSeries);
    if (chartView.notes.length > 0) {
      lines.push(...chartView.notes);
    }
    const plotWidth = Math.max(16, (terminalWidth ?? 80) - 14);
    const chartLines = renderCombinedChart(chartView.chartSeries, trendsData.metric, plotWidth).map(
      (line) => (useColor ? accent(line) : line),
    );
    lines.push(...chartLines);
  }

  lines.push('');
  lines.push(...renderSummaryLines(trendsData));

  return lines.join('\n');
}

const markdownIntegerFormatter = new Intl.NumberFormat('en-US');

function formatMarkdownMetricValue(bucket: TrendBucket | undefined, metric: TrendsMetric): string {
  if (bucket === undefined) {
    return '-';
  }

  if (metric === 'cost') {
    const formatted = usdFormatter.format(bucket.value);
    return bucket.incomplete === true ? `~${formatted}` : formatted;
  }

  if (metric === 'active-hours') {
    return formatDuration(bucket.value);
  }

  return markdownIntegerFormatter.format(bucket.value);
}

function formatMarkdownSummaryTotal(
  series: Pick<TrendSeries, 'summary'>,
  metric: TrendsMetric,
): string {
  if (metric === 'cost') {
    const formatted = usdFormatter.format(series.summary.total);
    return series.summary.incomplete ? `~${formatted}` : formatted;
  }

  if (metric === 'active-hours') {
    return formatDuration(series.summary.total);
  }

  return markdownIntegerFormatter.format(series.summary.total);
}

function renderMarkdownTrendsReport(trendsData: TrendsReportData): string {
  const metricLabel =
    trendsData.metric === 'cost'
      ? 'Cost'
      : trendsData.metric === 'active-hours'
        ? 'Active'
        : 'Tokens';
  const splitSeries = getSplitSeries(trendsData);
  const seriesColumns =
    splitSeries.length > 0 ? [trendsData.totalSeries, ...splitSeries] : [trendsData.totalSeries];
  const headers =
    splitSeries.length > 0
      ? ['Date', 'combined', ...splitSeries.map((series) => series.label)]
      : ['Date', metricLabel];
  const bucketsByDate = seriesColumns.map(
    (series) => new Map(series.buckets.map((bucket) => [bucket.date, bucket])),
  );
  const rows = trendsData.totalSeries.buckets.map((bucket) => [
    bucket.date,
    ...seriesColumns.map((series, columnIndex) =>
      formatMarkdownMetricValue(bucketsByDate[columnIndex].get(bucket.date), trendsData.metric),
    ),
  ]);
  const totalRow = [
    'Total',
    ...seriesColumns.map((series) => formatMarkdownSummaryTotal(series, trendsData.metric)),
  ];

  const table = markdownTable(
    [headers, ...rows, totalRow].map((row) => row.map((cell) => toMarkdownSafeCell(cell))),
    { align: ['l', ...seriesColumns.map(() => 'r' as const)] },
  );
  // Dates and amounts only, so the line needs no Markdown escaping.
  const spikeLine = formatSpikeLine(trendsData.totalSeries, (date) => date);

  return spikeLine === undefined ? table : `${table}\n\n${spikeLine}`;
}

export function renderTrendsReport(
  trendsData: TrendsReportData,
  format: TrendsReportFormat,
  options: RenderTrendsReportOptions = {},
): string {
  switch (format) {
    case 'json':
      return renderReportJson('trends', {
        metric: trendsData.metric,
        dateRange: trendsData.dateRange,
        totalSeries: trendsData.totalSeries,
        sourceSeries: trendsData.sourceSeries,
        projectSeries: trendsData.projectSeries,
      });
    case 'markdown':
      return renderMarkdownTrendsReport(trendsData);
    case 'terminal':
      return renderTerminalTrendsReport(trendsData, options);
  }
}
