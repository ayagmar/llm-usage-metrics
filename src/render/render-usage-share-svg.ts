import type { UsageDataResult } from '../cli/usage-data-contracts.js';
import type { GrandTotalRow, PeriodSourceRow, UsageReportRow } from '../domain/usage-report-row.js';
import { getPeriodKeyRange, type ReportGranularity } from '../utils/time-buckets.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import {
  escapeSvg,
  formatApproxUsd,
  formatCompact,
  formatInteger,
  getSourceColor,
  renderEmptyState,
  renderShareCard,
  renderStat,
  scaleY,
  SHARE_MARGIN,
  SHARE_WIDTH,
  svgText,
  truncateLabel,
  type ShareTheme,
} from './share-svg-theme.js';

const statsTop = 160;
const legendTop = 372;
const legendRowPitch = 26;
const chartLeft = 420;
const chartRight = SHARE_WIDTH - SHARE_MARGIN;
const chartTop = 170;
const chartBottom = 500;
// Six named sources fit the legend; the rest share one "other" series.
const MAX_NAMED_SOURCES = 6;
const MAX_PERIOD_LABELS = 8;
/** Slot width under which a centered label would cross the chart edge. */
const MIN_CENTERED_LABEL_SLOT = 80;
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

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

/** Series by total tokens, largest first; sources past the limit merge into "other". */
function buildSourceSeries(
  sourceRows: PeriodSourceRow[],
  periods: string[],
  theme: ShareTheme,
): SourceSeries[] {
  const periodIndex = new Map(periods.map((period, index) => [period, index]));
  const bySource = new Map<string, number[]>();

  for (const row of sourceRows) {
    const values = bySource.get(row.source) ?? periods.map(() => 0);
    values[periodIndex.get(row.periodKey) ?? 0] += row.totalTokens;
    bySource.set(row.source, values);
  }

  // Colors follow alphabetical order, as in every other report, so they stay stable.
  const colorBySource = new Map(
    [...bySource.keys()]
      .sort(compareByCodePoint)
      .map((source, index) => [source, getSourceColor(source, index)]),
  );
  const series = [...bySource]
    .map(([source, values]) => ({
      source,
      color: colorBySource.get(source) ?? theme.textMuted,
      total: values.reduce((sum, value) => sum + value, 0),
      values,
    }))
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total || compareByCodePoint(a.source, b.source));

  if (series.length <= MAX_NAMED_SOURCES) {
    return series;
  }

  const named = series.slice(0, MAX_NAMED_SOURCES - 1);
  const rest = series.slice(MAX_NAMED_SOURCES - 1);

  return [
    ...named,
    {
      source: `${rest.length} more`,
      color: theme.textMuted,
      total: rest.reduce((sum, entry) => sum + entry.total, 0),
      values: periods.map((_, index) => rest.reduce((sum, entry) => sum + entry.values[index], 0)),
    },
  ];
}

function granularityTitle(granularity: ReportGranularity): string {
  return `${granularity.charAt(0).toUpperCase()}${granularity.slice(1)} usage`;
}

function formatPeriodLabel(period: string, granularity: ReportGranularity): string {
  if (granularity === 'weekly') {
    return period.slice(5);
  }

  const month = MONTH_NAMES[Number(period.slice(5, 7)) - 1] ?? period;

  return granularity === 'daily'
    ? `${month} ${Number(period.slice(8, 10))}`
    : `${month} ${period.slice(0, 4)}`;
}

function renderLegend(series: SourceSeries[], totalTokens: number, theme: ShareTheme): string {
  return series
    .map((entry, index) => {
      const y = legendTop + index * legendRowPitch;
      const percent = totalTokens > 0 ? (entry.total / totalTokens) * 100 : 0;
      const share = percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`;

      return `<g data-legend="${escapeSvg(entry.source)}">
<rect x="${SHARE_MARGIN}" y="${y - 11}" width="12" height="12" rx="3" fill="${entry.color}"/>
${svgText(SHARE_MARGIN + 22, y, truncateLabel(entry.source, 18), { size: 16, fill: theme.text })}
${svgText(chartLeft - 64, y, share, { size: 15, fill: theme.textSecondary, mono: true, anchor: 'end' })}
</g>`;
    })
    .join('\n');
}

function renderGridLines(maxY: number, theme: ShareTheme): string {
  const lines: string[] = [];

  for (let step = 1; step <= 3; step += 1) {
    const value = (maxY / 3) * step;
    const y = scaleY(value, maxY, chartTop, chartBottom);

    lines.push(
      `<line x1="${chartLeft}" y1="${y.toFixed(2)}" x2="${chartRight}" y2="${y.toFixed(2)}" stroke="${theme.line}" stroke-width="1" stroke-dasharray="3 5"/>`,
      svgText(chartLeft - 10, y + 4, formatCompact(value), {
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

function renderBars(series: SourceSeries[], periodCount: number, maxY: number): string {
  const slot = (chartRight - chartLeft) / periodCount;
  const barWidth = Math.max(1, Math.min(56, slot * 0.68));
  const bars: string[] = [];

  for (let period = 0; period < periodCount; period += 1) {
    const x = chartLeft + period * slot + (slot - barWidth) / 2;
    let stackBase = 0;

    for (const entry of series) {
      const value = entry.values[period];

      if (value <= 0) {
        continue;
      }

      const yTop = scaleY(stackBase + value, maxY, chartTop, chartBottom);
      const yBottom = scaleY(stackBase, maxY, chartTop, chartBottom);
      bars.push(
        `<rect x="${x.toFixed(2)}" y="${yTop.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${(yBottom - yTop).toFixed(2)}" fill="${entry.color}"/>`,
      );
      stackBase += value;
    }
  }

  return bars.join('\n');
}

function renderPeriodLabels(
  periods: string[],
  granularity: ReportGranularity,
  theme: ShareTheme,
): string {
  const slot = (chartRight - chartLeft) / periods.length;
  const step = Math.ceil(periods.length / MAX_PERIOD_LABELS);
  const lastIndex = periods.length - 1;
  // Every step-th period, plus the last one; a step label too close to it is dropped.
  const indexes = [];

  for (let index = 0; index < lastIndex; index += step) {
    if (lastIndex - index >= step * 0.6) {
      indexes.push(index);
    }
  }

  indexes.push(lastIndex);

  return indexes
    .map((index) => {
      const center = chartLeft + index * slot + slot / 2;
      // A narrow last slot would center its label past the chart edge, so it ends there instead.
      const alignEnd = index === lastIndex && slot < MIN_CENTERED_LABEL_SLOT;

      return svgText(
        alignEnd ? chartRight : center,
        chartBottom + 26,
        formatPeriodLabel(periods[index], granularity),
        { size: 13, fill: theme.textMuted, anchor: alignEnd ? 'end' : 'middle' },
      );
    })
    .join('\n');
}

export function renderUsageShareSvg(
  usageData: UsageDataResult,
  granularity: ReportGranularity,
  theme: ShareTheme,
): string {
  const sourceRows = extractPeriodSourceRows(usageData.rows);
  const grandTotal = extractGrandTotal(usageData.rows);
  const usedPeriods = [...new Set(sourceRows.map((r) => r.periodKey))].sort(compareByCodePoint);
  // Periods without usage keep an empty slot, so the bars never read as consecutive.
  const periods =
    usedPeriods.length === 0
      ? []
      : getPeriodKeyRange(usedPeriods[0], usedPeriods[usedPeriods.length - 1], granularity);
  const series = buildSourceSeries(sourceRows, periods, theme);
  const totalTokens = grandTotal?.totalTokens ?? 0;
  const range =
    periods.length === 0
      ? undefined
      : periods.length === 1
        ? periods[0]
        : `${periods[0]} to ${periods[periods.length - 1]}`;
  const periodTotals = periods.map((_, index) =>
    series.reduce((sum, entry) => sum + entry.values[index], 0),
  );
  const maxY = Math.max(1, ...periodTotals) * 1.08;
  const body =
    series.length === 0
      ? renderEmptyState(theme, 'No usage in this window')
      : [
          renderStat({
            theme,
            x: SHARE_MARGIN,
            y: statsTop,
            label: 'Cost',
            value: formatApproxUsd(grandTotal?.costUsd, grandTotal?.costIncomplete),
            size: 44,
            accent: true,
          }),
          renderStat({
            theme,
            x: SHARE_MARGIN,
            y: statsTop + 108,
            label: 'Tokens',
            value: formatCompact(totalTokens),
            detail: `${formatInteger(usedPeriods.length)} ${granularity === 'daily' ? 'days' : granularity === 'weekly' ? 'weeks' : 'months'} with usage`,
            size: 30,
          }),
          renderLegend(series, totalTokens, theme),
          renderGridLines(maxY, theme),
          renderBars(series, periods.length, maxY),
          renderPeriodLabels(periods, granularity, theme),
        ].join('\n');

  return renderShareCard({
    theme,
    title: granularityTitle(granularity),
    subtitle: 'Tokens by source',
    command: `llm-usage ${granularity} --share`,
    footnote: range,
    body,
  });
}
