import pc from 'picocolors';

import type { TrendsDataResult } from '../cli/usage-data-contracts.js';
import type { TrendBucket, TrendSeries, TrendsMetric } from '../trends/trends-series.js';
import { renderReportHeader } from './report-header.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { resolveTtyColumns, visibleWidth } from './table-text-layout.js';

export type TrendsReportFormat = 'terminal' | 'json';

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

const compactNumberFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const sparklineBlocks = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

function resolveTerminalWidth(override: number | undefined): number | undefined {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }

  return resolveTtyColumns(process.stdout as { isTTY?: unknown; columns?: unknown });
}

function formatMetricValue(value: number, metric: TrendsMetric, approximate = false): string {
  if (metric === 'cost') {
    const formatted = usdFormatter.format(value);
    return approximate ? `~${formatted}` : formatted;
  }

  return compactNumberFormatter.format(value);
}

function formatAxisValue(value: number, metric: TrendsMetric): string {
  return metric === 'cost' ? usdFormatter.format(value) : compactNumberFormatter.format(value);
}

function formatDateLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(parsed);
}

function getReportTitle(trendsData: TrendsDataResult): string {
  const metricLabel = trendsData.metric === 'cost' ? 'Cost' : 'Token Usage';
  const bucketCount = trendsData.totalSeries.buckets.length;
  const dayLabel = bucketCount === 1 ? 'day' : 'days';
  const sourceSuffix =
    trendsData.sourceSeries && trendsData.sourceSeries.length > 0 ? ' by Source' : '';

  return `Daily ${metricLabel} Trend${sourceSuffix} (${bucketCount} ${dayLabel})`;
}

function downsampleBuckets(buckets: TrendBucket[], maxColumns: number): TrendBucket[] {
  if (maxColumns <= 0 || buckets.length <= maxColumns) {
    return buckets;
  }

  return Array.from({ length: maxColumns }, (_, columnIndex) => {
    const startIndex = Math.floor((columnIndex * buckets.length) / maxColumns);
    const endIndex = Math.floor(((columnIndex + 1) * buckets.length) / maxColumns);
    const slice = buckets.slice(startIndex, Math.max(startIndex + 1, endIndex));
    const peakValue = slice.reduce((maxValue, bucket) => Math.max(maxValue, bucket.value), 0);

    return {
      date: slice[0]?.date ?? '',
      value: peakValue,
      observed: slice.some((bucket) => bucket.observed),
      incomplete: slice.some((bucket) => bucket.incomplete === true) || undefined,
    };
  });
}

function getBarLevel(value: number, maxValue: number, rowCount: number): number {
  if (value <= 0 || maxValue <= 0 || rowCount <= 0) {
    return 0;
  }

  return Math.max(1, Math.min(rowCount * 8, Math.round((value / maxValue) * rowCount * 8)));
}

function renderCombinedChartCell(barLevel: number, rowIndex: number, rowCount: number): string {
  const rowBaseLevel = (rowCount - rowIndex - 1) * 8;
  const cellLevel = Math.max(0, Math.min(8, barLevel - rowBaseLevel));

  return sparklineBlocks[cellLevel];
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

function shouldShowNoResolvedCostDataNote(trendsData: TrendsDataResult): boolean {
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

function renderSummaryOnly(
  trendsData: TrendsDataResult,
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
    lines.push('No usage data found for the selected date range.');
    lines.push('');
  }

  if (shouldShowNoResolvedCostDataNote(trendsData)) {
    lines.push(
      'No resolved cost data for the selected range; use pricing or switch to --metric tokens.',
    );
    lines.push('');
  }

  lines.push(renderSummary(trendsData.totalSeries, trendsData.metric));
  return lines.join('\n');
}

function renderCombinedChart(
  series: TrendSeries,
  metric: TrendsMetric,
  plotWidth: number,
): string[] {
  const buckets = downsampleBuckets(series.buckets, plotWidth);
  const maxValue = Math.max(...buckets.map((bucket) => bucket.value), 0);
  const lines: string[] = [];
  const chartRowCount = 4;
  const tickValues = Array.from({ length: chartRowCount + 1 }, (_, index) => {
    const inverseIndex = chartRowCount - index;
    return maxValue === 0 ? 0 : (maxValue * inverseIndex) / chartRowCount;
  });
  const labelWidth = tickValues.reduce(
    (maxWidth, value) => Math.max(maxWidth, visibleWidth(formatAxisValue(value, metric))),
    0,
  );
  const barLevels = buckets.map((bucket) => getBarLevel(bucket.value, maxValue, chartRowCount));

  tickValues.forEach((tickValue, tickIndex) => {
    if (tickIndex === tickValues.length - 1) {
      lines.push(
        `${formatAxisValue(0, metric).padStart(labelWidth)} ┼${'─'.repeat(buckets.length)}`,
      );
      return;
    }

    const glyphs = barLevels
      .map((barLevel) => renderCombinedChartCell(barLevel, tickIndex, chartRowCount))
      .join('');

    lines.push(`${formatAxisValue(tickValue, metric).padStart(labelWidth)} ┤${glyphs}`);
  });

  const startLabel = formatDateLabel(series.buckets[0]?.date ?? '');
  const endLabel = formatDateLabel(series.buckets.at(-1)?.date ?? '');
  const middleLabel =
    series.buckets.length > 2
      ? formatDateLabel(series.buckets[Math.floor(series.buckets.length / 2)]?.date ?? '')
      : '';
  const xAxisWidth = Math.max(
    buckets.length,
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

function renderSourceLines(
  sourceSeries: TrendSeries[],
  metric: TrendsMetric,
  width: number,
): string[] {
  const labelWidth = sourceSeries.reduce(
    (maxWidth, series) => Math.max(maxWidth, visibleWidth(series.source)),
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
    const buckets = downsampleBuckets(series.buckets, sparklineWidth);
    const maxValue = Math.max(...buckets.map((bucket) => bucket.value), 0);
    const sparkline = buckets
      .map((bucket) => {
        if (maxValue === 0) {
          return ' ';
        }

        const level =
          bucket.value > 0
            ? Math.max(1, Math.min(8, Math.round((bucket.value / maxValue) * 8)))
            : 0;
        return sparklineBlocks[level];
      })
      .join('');

    return `${series.source.padEnd(labelWidth)} ${sparkline} ${formatMetricValue(series.summary.total, metric, series.summary.incomplete).padStart(totalWidth)}`;
  });
}

function renderTerminalTrendsReport(
  trendsData: TrendsDataResult,
  options: RenderTrendsReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const terminalWidth = resolveTerminalWidth(options.terminalWidth);
  const accent = trendsData.metric === 'cost' ? pc.green : pc.cyan;
  const minimumChartWidth = 40;

  if (terminalWidth !== undefined && terminalWidth < minimumChartWidth) {
    return renderSummaryOnly(trendsData, { useColor, narrowNote: true });
  }

  const lines = [
    renderReportHeader({
      title: getReportTitle(trendsData),
      useColor,
    }),
    '',
  ];

  if (trendsData.totalSeries.summary.observedDayCount === 0) {
    lines.push('No usage data found for the selected date range.');
    lines.push('');
  }

  if (shouldShowNoResolvedCostDataNote(trendsData)) {
    lines.push(
      'No resolved cost data for the selected range; use pricing or switch to --metric tokens.',
    );
    lines.push('');
  }

  if (trendsData.sourceSeries && trendsData.sourceSeries.length > 0) {
    lines.push(
      ...renderSourceLines(trendsData.sourceSeries, trendsData.metric, terminalWidth ?? 80),
    );
  } else {
    const plotWidth = Math.max(16, (terminalWidth ?? 80) - 14);
    const chartLines = renderCombinedChart(
      trendsData.totalSeries,
      trendsData.metric,
      plotWidth,
    ).map((line) => (useColor ? accent(line) : line));
    lines.push(...chartLines);
  }

  lines.push('');
  lines.push(renderSummary(trendsData.totalSeries, trendsData.metric));

  return lines.join('\n');
}

export function renderTrendsReport(
  trendsData: TrendsDataResult,
  format: TrendsReportFormat,
  options: RenderTrendsReportOptions = {},
): string {
  switch (format) {
    case 'json':
      return JSON.stringify(
        {
          metric: trendsData.metric,
          dateRange: trendsData.dateRange,
          totalSeries: trendsData.totalSeries,
          sourceSeries: trendsData.sourceSeries,
        },
        null,
        2,
      );
    case 'terminal':
      return renderTerminalTrendsReport(trendsData, options);
  }
}
