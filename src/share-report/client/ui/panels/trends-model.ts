// The trends lead: the command's daily series as bars with its peak and average marked, its
// total, average and peak as the terminal prints them, and the per-source or per-project
// totals, from the embedded `trends --json` data. Fixed at generation: the page's filters do
// not change it.

import { formatDuration } from '../../../../render/format-duration.js';
import { NO_VALUE, type ShareReport } from '../../core/index.js';
import type { ShareLabels } from '../state/context.js';
import { formatDateRange, formatDay } from '../shell/format.js';
import {
  figure,
  FIXED_NOTE,
  formatEnvelopeCost,
  getEnvelopeData,
  isRecord,
  readNumber,
  readRecords,
  readString,
  words,
  type LedePart,
  type PanelTable,
} from './model.js';
import { pluralize } from '../../../../../packages/core/src/utils/pluralize.js';
import { formatAbbreviatedTokenCount, formatInteger } from '../../../../render/format-number.js';

/** A bar in the series chart, in SVG user units. */
export type TrendBar = {
  x: number;
  y: number;
  width: number;
  height: number;
  peak: boolean;
  /** The day and its value, as a tooltip. */
  label: string;
};

export type TrendChart = {
  width: number;
  height: number;
  bars: TrendBar[];
  /** The average's rule across the plot, and its legend. */
  average: { y: number; label: string };
  /** The tallest bar's legend: its value and day. */
  peak: string;
  /** The first, middle and last day under the bars. */
  dates: string[];
  /** One sentence for screen readers; the table holds every day. */
  summary: string;
};

export type TrendsView = {
  title: string;
  lede: LedePart[];
  chart: TrendChart | undefined;
  /** The days with usage: the chart's table equivalent. */
  days: PanelTable;
  tables: PanelTable[];
  note: string;
};

type Metric = 'tokens' | 'cost' | 'active-hours';

const METRIC_NAMES: Record<Metric, string> = {
  tokens: 'token usage',
  cost: 'cost',
  'active-hours': 'active hours',
};

function readMetric(data: Record<string, unknown>): Metric | undefined {
  const metric = data.metric;
  return metric === 'tokens' || metric === 'cost' || metric === 'active-hours' ? metric : undefined;
}

/** A value as the terminal prints it: compact tokens, dollars, or its duration from ms. */
function formatValue(value: number, metric: Metric, approximate = false): string {
  if (metric === 'cost') {
    return formatEnvelopeCost(value, approximate).text;
  }

  return metric === 'active-hours' ? formatDuration(value) : formatAbbreviatedTokenCount(value);
}

/** A value in full for tooltips and tables: exact tokens, dollars, or a duration. */
function formatExact(value: number, metric: Metric, approximate = false): string {
  return metric === 'tokens' ? formatInteger(value) : formatValue(value, metric, approximate);
}

type Series = {
  buckets: Record<string, unknown>[];
  total: number;
  average: number;
  peak: { date: string; value: number } | undefined;
  incomplete: boolean;
  observedDays: number;
};

function readSeries(record: Record<string, unknown>): Series {
  const summary = isRecord(record.summary) ? record.summary : {};
  const peak = isRecord(summary.peak) ? summary.peak : undefined;
  const observedDays = readNumber(summary, 'observedDayCount') ?? 0;

  return {
    buckets: readRecords(record.buckets),
    total: readNumber(summary, 'total') ?? 0,
    average: readNumber(summary, 'average') ?? 0,
    // The CLI's peak means nothing on a series with no observed day.
    peak:
      peak && observedDays > 0
        ? { date: readString(peak, 'date') ?? '', value: readNumber(peak, 'value') ?? 0 }
        : undefined,
    incomplete: summary.incomplete === true,
    observedDays,
  };
}

/** The peak is approximate when its own day had unpriced events, as the terminal marks it. */
function isPeakApproximate(series: Series, metric: Metric): boolean {
  return (
    metric === 'cost' &&
    series.buckets.some((bucket) => bucket.date === series.peak?.date && bucket.incomplete === true)
  );
}

// The plot stretches to the page's width; bars and the rule need no text inside it.
const WIDTH = 720;
const HEIGHT = 160;
const TOP = 4;

/** The bars, scaled to the largest day; undefined when every day is zero. */
function buildChart(series: Series, metric: Metric, name: string): TrendChart | undefined {
  const values = series.buckets.map((bucket) => readNumber(bucket, 'value') ?? 0);
  const largest = Math.max(0, ...values);

  if (largest <= 0 || values.length === 0) {
    return undefined;
  }

  const plot = HEIGHT - TOP;
  const pitch = WIDTH / values.length;
  const width = Math.max(pitch * 0.72, 1);
  const yOf = (value: number) => TOP + plot * (1 - value / largest);
  const peakIndex = values.indexOf(largest);
  const dateOf = (index: number) => readString(series.buckets[index] ?? {}, 'date') ?? '';
  const last = values.length - 1;
  const average = formatValue(series.average, metric, metric === 'cost' && series.incomplete);
  const peak = `${
    series.peak
      ? formatValue(series.peak.value, metric, isPeakApproximate(series, metric))
      : formatValue(largest, metric)
  } on ${formatDay(dateOf(peakIndex))}`;

  return {
    width: WIDTH,
    height: HEIGHT,
    bars: values.map((value, index) => ({
      x: index * pitch + (pitch - width) / 2,
      y: yOf(value),
      width,
      height: plot * (value / largest),
      peak: index === peakIndex,
      label: `${formatDay(dateOf(index))}: ${formatExact(value, metric, series.buckets[index]?.incomplete === true)}${metric === 'tokens' ? ' tokens' : ''}`,
    })),
    average: { y: yOf(series.average), label: `Average ${average}/day` },
    peak: `Peak ${peak}`,
    dates: [...new Set([0, Math.floor(last / 2), last])].map((index) => formatDay(dateOf(index))),
    summary: `Daily ${name} over ${pluralize(values.length, 'day')}: peak ${peak}, average ${average} a day.`,
  };
}

function daysTable(series: Series, metric: Metric): PanelTable {
  return {
    title: 'Days with usage',
    columns: [
      { label: 'Day', numeric: false },
      {
        label: metric === 'tokens' ? 'Tokens' : metric === 'cost' ? 'Cost' : 'Active',
        numeric: true,
      },
    ],
    rows: series.buckets
      .filter((bucket) => (readNumber(bucket, 'value') ?? 0) > 0)
      .map((bucket) => [
        { text: formatDay(readString(bucket, 'date') ?? '') },
        {
          text: formatExact(readNumber(bucket, 'value') ?? 0, metric, bucket.incomplete === true),
        },
      ]),
    foot: [],
  };
}

/** The per-source or per-project series, by their totals as the terminal lists them. */
function splitTable(
  data: Record<string, unknown>,
  metric: Metric,
  labels: ShareLabels,
): PanelTable | undefined {
  const bySource = readRecords(data.sourceSeries);
  const byProject = readRecords(data.projectSeries);
  const rows = bySource.length > 0 ? bySource : byProject;

  if (rows.length === 0) {
    return undefined;
  }

  const kind = bySource.length > 0 ? 'Source' : 'Project';
  const nameOf = (row: Record<string, unknown>) =>
    kind === 'Source'
      ? (readString(row, 'source') ?? NO_VALUE)
      : labels.project(readString(row, 'project') ?? NO_VALUE);

  return {
    title: `By ${kind.toLowerCase()}`,
    columns: [
      { label: kind, numeric: false },
      { label: 'Total', numeric: true },
      // A phone keeps the name, the total and the peak.
      { label: 'Average a day', numeric: true, narrow: false },
      { label: 'Peak', numeric: true },
      { label: 'Peak day', numeric: false, narrow: false },
    ],
    rows: rows.map((row) => {
      const series = readSeries(row);
      const approximate = metric === 'cost' && series.incomplete;
      return [
        { text: nameOf(row) },
        { text: formatValue(series.total, metric, approximate) },
        { text: formatValue(series.average, metric, approximate) },
        {
          text: series.peak
            ? formatValue(series.peak.value, metric, isPeakApproximate(series, metric))
            : NO_VALUE,
        },
        { text: series.peak ? formatDay(series.peak.date) : NO_VALUE },
      ];
    }),
    foot: [],
  };
}

/** `2.17K tokens over 181 days, 12 a day on average, peaking at 970 on 15 Jun 2026.` */
function buildLede(series: Series, metric: Metric, days: number): LedePart[] {
  if (series.observedDays === 0) {
    const span = days === 1 ? 'on this day' : `in these ${formatInteger(days)} days`;
    return [words(`No ${METRIC_NAMES[metric]} ${span}.`)];
  }

  const approximate = metric === 'cost' && series.incomplete;
  const unit = metric === 'tokens' ? ' tokens' : metric === 'cost' ? '' : ' active';

  return [
    figure(formatValue(series.total, metric, approximate)),
    words(`${unit} over ${pluralize(days, 'day')}, `),
    figure(formatValue(series.average, metric, approximate)),
    words(' a day on average'),
    ...(series.peak
      ? [
          words(', peaking at '),
          figure(formatValue(series.peak.value, metric, isPeakApproximate(series, metric))),
          words(` on ${formatDay(series.peak.date)}`),
        ]
      : []),
    words('.'),
  ];
}

/** The trends lead, or undefined when the file's trends data cannot be read. */
export function buildTrendsView(report: ShareReport, labels: ShareLabels): TrendsView | undefined {
  const data = getEnvelopeData(report, 'trends');
  const metric = isRecord(data) ? readMetric(data) : undefined;

  if (!isRecord(data) || metric === undefined || !isRecord(data.totalSeries)) {
    return undefined;
  }

  const series = readSeries(data.totalSeries);
  const days = series.buckets.length;
  const range = isRecord(data.dateRange) ? data.dateRange : {};
  const split = splitTable(data, metric, labels);
  const name = METRIC_NAMES[metric];

  return {
    title: `Daily ${name}`,
    lede: buildLede(series, metric, days),
    chart: buildChart(series, metric, name),
    days: daysTable(series, metric),
    tables: split ? [split] : [],
    note: `From the trends command: ${name} each day, ${formatDateRange(readString(range, 'from') ?? null, readString(range, 'to') ?? null).replace(/^A/u, 'a')}. ${FIXED_NOTE}`,
  };
}
