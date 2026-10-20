import { markdownTable } from 'markdown-table';

import { SPIKE_BASELINE_DAYS } from '../aggregate/spend-spikes.js';
import type {
  SummaryDataResult,
  SummaryPeriod,
  SummarySpendSpike,
} from '../cli/usage-data-contracts.js';
import { renderActivityHeatmap } from './activity-heatmap.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import { pluralize } from '@ayagmar/agent-sessions/internal';
import {
  formatAbbreviatedTokenCount,
  formatApproxUsd,
  formatInteger,
  formatUsd,
} from './format-number.js';
import { resolveTerminalWidth, wrapProse } from './table-text-layout.js';
import {
  createColorRoles,
  defaultTerminalStylePalette,
  type ColorRoles,
  type TerminalStylePalette,
  type TextStyler,
} from './terminal-style-policy.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import { describeTableFit, type RenderedReportWithNotes } from './table-fit-note.js';
import { renderUnicodeTableWithFit, type TableRowMeta } from './unicode-table.js';

export type SummaryReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderSummaryReportOptions = {
  useColor?: boolean;
  palette?: TerminalStylePalette;
  /** Overrides the TTY width the table, notes, and activity heatmap are fitted to. */
  terminalWidth?: number;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
};

const summaryTableHeaders = ['Period', 'Cost', 'Tokens', 'Top source'] as const;
const TOP_SOURCE_COLUMN = 3;
// `~$110,334.21`: the best day's widest word, so it wraps between words, not inside one.
const MIN_WRAPPED_VALUE_WIDTH = 12;

function formatCost(period: SummaryPeriod): string {
  // A `~` marks totals that leave out events whose model has no known price.
  return formatApproxUsd(period.totals.costUsd, period.totals.costIncomplete);
}

/** A part's share of the period cost, or undefined when either cost is unknown or zero. */
function formatCostShare(period: SummaryPeriod, costUsd: number | undefined): string | undefined {
  const totalCost = period.totals.costUsd ?? 0;

  if (totalCost <= 0 || costUsd === undefined) {
    return undefined;
  }

  // Like the Cost column, a `~` marks a share computed from incomplete costs.
  return `${period.totals.costIncomplete ? '~' : ''}${String(Math.round((costUsd / totalCost) * 100))}%`;
}

function formatTopSource(period: SummaryPeriod, styleSource: (source: string) => string): string {
  if (period.sources.length === 0) {
    return '-';
  }

  const topSource = period.sources[0];
  const share = formatCostShare(period, topSource.costUsd);
  const source = styleSource(topSource.source);
  return share === undefined ? source : `${source} (${share})`;
}

type SummaryRowStyle = {
  formatTokens: (tokens: number) => string;
  money: TextStyler;
  source: (source: string) => string;
};

const plainRowStyle: SummaryRowStyle = {
  formatTokens: formatInteger,
  money: (text) => text,
  source: (source) => source,
};

function toTableRow(period: SummaryPeriod, style: SummaryRowStyle = plainRowStyle): string[] {
  return [
    period.label,
    style.money(formatCost(period)),
    style.formatTokens(period.totals.totalTokens),
    formatTopSource(period, style.source),
  ];
}

function hasAnyUsage(summaryData: SummaryDataResult): boolean {
  return summaryData.periods.some((period) => period.totals.events > 0);
}

function toNoRecentUsageMessage(summaryData: SummaryDataResult, filtered: boolean): string {
  const recentScope = 'in the last 7 days or this month';

  if (filtered) {
    return formatNoUsageMessage(true, recentScope);
  }

  // Synced machines can supply usage even when this machine has no files.
  const latestDay = summaryData.activity.days.filter((day) => day.totalTokens > 0).at(-1);

  if (latestDay) {
    return `${formatNoUsageMessage(false, recentScope)} Latest usage: ${latestDay.date}. Try \`llm-usage monthly --all\`.`;
  }

  if (summaryData.diagnostics.sessionStats.some((stat) => stat.filesFound > 0)) {
    return `${formatNoUsageMessage(false, 'in the past year')} Try \`llm-usage monthly --all\`.`;
  }

  return `${formatNoUsageMessage(false, recentScope)} Run \`llm-usage doctor\` to see which sources were found.`;
}

function getTitle(summaryData: SummaryDataResult): string {
  const today = summaryData.periods[0]?.until ?? '';
  return `Usage summary for ${today} (${summaryData.timezone})`;
}

function formatBestDay(activity: SummaryDataResult['activity']): string {
  const bestDay = activity.bestDay;

  if (bestDay === undefined) {
    return '-';
  }

  const cost =
    bestDay.costUsd === undefined
      ? ''
      : ` · ${formatApproxUsd(bestDay.costUsd, bestDay.costIncomplete)}`;
  return `${bestDay.date}${cost} · ${formatAbbreviatedTokenCount(bestDay.totalTokens)} tokens`;
}

function toActivityStats(activity: SummaryDataResult['activity']): [string, string][] {
  return [
    ['Current streak', pluralize(activity.currentStreak, 'day')],
    ['Longest streak', pluralize(activity.longestStreak, 'day')],
    ['Best day', formatBestDay(activity)],
    ['Active days', formatInteger(activity.activeDays)],
  ];
}

function renderTerminalActivity(
  activity: SummaryDataResult['activity'],
  options: { roles: ColorRoles; palette: TerminalStylePalette; useColor: boolean },
  terminalWidth: number | undefined,
): string[] {
  const { roles, palette, useColor } = options;
  const paint =
    (styler: TextStyler): TextStyler =>
    (text) =>
      useColor ? styler(text) : text;
  const dim = roles.dim;
  const stats = toActivityStats(activity);
  const labelWidth = Math.max(...stats.map(([label]) => label.length));
  const valueIndent = ' '.repeat(labelWidth + 2);
  // Too little room to wrap into; such a line overflows rather than breaking every word.
  const valueWidth =
    terminalWidth === undefined || terminalWidth - valueIndent.length < MIN_WRAPPED_VALUE_WIDTH
      ? undefined
      : terminalWidth - valueIndent.length;
  const heatmap = renderActivityHeatmap(
    activity.days,
    {
      dim,
      level: (level) =>
        level === 0
          ? dim
          : level >= 3
            ? paint((text) => palette.bold(palette.green(text)))
            : paint(palette.green),
    },
    terminalWidth,
  );

  return [
    '',
    `Activity ${dim(`since ${activity.from}`)}`,
    // A value too long for the line (the best day, on a phone) continues under itself.
    ...stats.flatMap(([label, value]) =>
      wrapProse(value, valueWidth)
        .split('\n')
        .map((line, index) =>
          index === 0 ? `${roles.label(label.padEnd(labelWidth))}  ${line}` : valueIndent + line,
        ),
    ),
    ...(heatmap.length > 0 ? ['', ...heatmap] : []),
  ];
}

type SummaryNote = { text: string; warning: boolean };

function formatTokenShare(tokens: number, totalTokens: number): string {
  return `${String(Math.round((tokens / totalTokens) * 100))}%`;
}

/**
 * Each machine's cost this month, when the month counts usage from more than one;
 * its tokens instead when the month has no known cost.
 */
function formatMachinesNote(monthToDate: SummaryPeriod | undefined): string | undefined {
  if (monthToDate?.machines === undefined || monthToDate.machines.length < 2) {
    return undefined;
  }

  const byCost = (monthToDate.totals.costUsd ?? 0) > 0;

  if (!byCost && monthToDate.totals.totalTokens === 0) {
    return undefined;
  }

  const parts = monthToDate.machines.map((machine) => {
    if (!byCost) {
      const share = formatTokenShare(machine.totalTokens, monthToDate.totals.totalTokens);
      return `${machine.machine} ${formatAbbreviatedTokenCount(machine.totalTokens)} tokens (${share})`;
    }

    const cost = formatApproxUsd(machine.costUsd, machine.costIncomplete);
    const share = formatCostShare(monthToDate, machine.costUsd);
    return share === undefined
      ? `${machine.machine} ${cost}`
      : `${machine.machine} ${cost} (${share})`;
  });

  return `This month by machine: ${parts.join(', ')}`;
}

type EscapeName = (name: string) => string;

const keepName: EscapeName = (name) => name;

function formatSpikeNote(spike: SummarySpendSpike, escapeName: EscapeName): string {
  const multiple = (spike.costUsd / spike.medianActiveDayUsd).toFixed(1);
  const against = `${multiple}× the median active day (${formatUsd(spike.medianActiveDayUsd)}) of the ${SPIKE_BASELINE_DAYS} days before`;
  const drivers = [
    ...(spike.project === undefined ? [] : [`top project ${escapeName(spike.project)}`]),
    ...(spike.model === undefined ? [] : [`top model ${escapeName(spike.model)}`]),
  ];
  const cost = formatApproxUsd(spike.costUsd, spike.costIncomplete);

  return `Spend spike on ${spike.date}: ${cost}, ${against}${drivers.length > 0 ? `; ${drivers.join(', ')}` : ''}`;
}

/**
 * The last 7 days' spend spike, then cost by machine, month-end projection, budget status,
 * and cache savings, in that order. `escapeName` escapes the project and model names.
 */
function toSummaryNotes(summaryData: SummaryDataResult, escapeName: EscapeName): SummaryNote[] {
  const { monthEnd } = summaryData;
  const monthToDate = summaryData.periods.find((period) => period.key === 'monthToDate');
  const spentUsd = monthToDate?.totals.costUsd;
  const spent = formatApproxUsd(spentUsd, monthToDate?.totals.costIncomplete);
  const notes: SummaryNote[] =
    summaryData.spike === undefined
      ? []
      : [{ text: formatSpikeNote(summaryData.spike, escapeName), warning: false }];
  const machinesNote = formatMachinesNote(monthToDate);

  if (machinesNote !== undefined) {
    notes.push({ text: machinesNote, warning: false });
  }

  if (monthEnd.projectedCostUsd !== undefined) {
    notes.push({
      text: `On pace for ${formatApproxUsd(monthEnd.projectedCostUsd, monthEnd.costIncomplete)} this month`,
      warning: false,
    });
  }

  // An empty month has nothing to hold against the budget yet.
  if (monthEnd.budgetUsd !== undefined && (monthToDate?.totals.events ?? 0) > 0) {
    const budget = formatUsd(monthEnd.budgetUsd);

    if (spentUsd === undefined) {
      notes.push({
        text: `Monthly budget ${budget}: this month's cost is unknown (no pricing for its usage)`,
        warning: false,
      });
    } else if (spentUsd > monthEnd.budgetUsd) {
      notes.push({ text: `Over your ${budget} monthly budget: ${spent} spent`, warning: true });
    } else if ((monthEnd.projectedCostUsd ?? 0) > monthEnd.budgetUsd) {
      const overBy = formatApproxUsd(
        (monthEnd.projectedCostUsd ?? 0) - monthEnd.budgetUsd,
        monthEnd.costIncomplete,
      );
      notes.push({
        text: `On pace to exceed your ${budget} monthly budget by ${overBy}`,
        warning: true,
      });
    } else {
      notes.push({ text: `Within your ${budget} monthly budget (${spent} spent)`, warning: false });
    }
  }

  if (summaryData.monthToDateCacheSavingsUsd !== undefined) {
    // The savings are an estimate, so they always carry the approximate marker.
    notes.push({
      text: `Prompt caching saved you ${formatApproxUsd(summaryData.monthToDateCacheSavingsUsd, true)} this month`,
      warning: false,
    });
  }

  return notes;
}

function renderTerminalSummaryReport(
  summaryData: SummaryDataResult,
  options: RenderSummaryReportOptions,
): RenderedReportWithNotes {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const palette = options.palette ?? defaultTerminalStylePalette;
  const roles = createColorRoles(useColor, palette);
  const terminalWidth = resolveTerminalWidth(options.terminalWidth);
  const toRows = (formatTokens: SummaryRowStyle['formatTokens'], colored: boolean) =>
    summaryData.periods.map((period) =>
      toTableRow(
        period,
        colored
          ? { formatTokens, money: roles.money, source: (source) => roles.source(source)(source) }
          : { ...plainRowStyle, formatTokens },
      ),
    );
  const measureBodyRows = toRows(formatInteger, false);
  const rowMetas: TableRowMeta[] = measureBodyRows.map(() => ({
    periodKey: 'summary',
    rowKind: 'detail',
  }));
  const lines = [
    renderReportHeader({
      title: getTitle(summaryData),
      useColor,
      terminalWidth,
    }),
    '',
  ];

  if (!hasAnyUsage(summaryData)) {
    lines.push(
      wrapProse(toNoRecentUsageMessage(summaryData, options.filtered ?? false), terminalWidth),
      '',
    );
  }

  const { output: table, fit } = renderUnicodeTableWithFit({
    headerCells: summaryTableHeaders.map((header) => roles.header(header)),
    bodyRows: toRows(formatInteger, true),
    measureHeaderCells: summaryTableHeaders,
    measureBodyRows,
    rowMetas,
    multilineColumnIndex: 0,
    columnKinds: ['text', 'measure', 'measure', 'text'],
    multilineColumnWidth: 13,
    terminalWidth,
    fit: {
      abbreviatedBodyRows: toRows(formatAbbreviatedTokenCount, true),
      abbreviatedMeasureBodyRows: toRows(formatAbbreviatedTokenCount, false),
      hideableColumns: [TOP_SOURCE_COLUMN],
    },
  });
  const fitNote = describeTableFit(fit);

  lines.push(table);

  const notes = toSummaryNotes(summaryData, keepName);

  if (notes.length > 0) {
    // Wrapped before coloring, so escape codes do not count toward the width.
    const styleLines = (text: string, styler: TextStyler) =>
      wrapProse(text, terminalWidth)
        .split('\n')
        .map((line) => styler(line));
    lines.push(
      '',
      ...notes.flatMap((note) =>
        note.warning
          ? styleLines(`⚠ ${note.text}`, roles.warning)
          : styleLines(note.text, roles.dim),
      ),
    );
  }

  if (summaryData.activity.activeDays > 0) {
    lines.push(
      ...renderTerminalActivity(summaryData.activity, { roles, palette, useColor }, terminalWidth),
    );
  }

  return { output: lines.join('\n'), notes: fitNote ? [fitNote] : [] };
}

function renderMarkdownSummaryReport(summaryData: SummaryDataResult): string {
  const rows = [
    ['Period', 'Dates', 'Cost', 'Tokens', 'Top source'],
    ...summaryData.periods.map((period) => {
      const [label, ...values] = toTableRow(period);
      const dates =
        period.since === period.until ? period.since : `${period.since} to ${period.until}`;
      return [label, dates, ...values];
    }),
  ];

  return [
    // The title is a date and a validated timezone, so it needs no escaping.
    `### ${getTitle(summaryData)}`,
    '',
    markdownTable(
      rows.map((row) => row.map((cell) => toMarkdownSafeCell(cell))),
      { align: ['l', 'l', 'r', 'r', 'l'] },
    ),
    // Notes are plain sentences of dates and amounts; only the names in them need escaping.
    ...toSummaryNotes(summaryData, toMarkdownSafeCell).flatMap((note) => [
      '',
      note.warning ? `⚠ ${note.text}` : note.text,
    ]),
    '',
    `#### Activity since ${summaryData.activity.from}`,
    '',
    markdownTable(
      [['Stat', 'Value'], ...toActivityStats(summaryData.activity)].map((row) =>
        row.map((cell) => toMarkdownSafeCell(cell)),
      ),
      { align: ['l', 'r'] },
    ),
  ].join('\n');
}

export function renderSummaryReportWithNotes(
  summaryData: SummaryDataResult,
  format: SummaryReportFormat,
  options: RenderSummaryReportOptions = {},
): RenderedReportWithNotes {
  switch (format) {
    case 'json':
      return {
        output: renderReportJson('summary', {
          timezone: summaryData.timezone,
          periods: summaryData.periods,
          monthEnd: summaryData.monthEnd,
          monthToDateCacheSavingsUsd: summaryData.monthToDateCacheSavingsUsd,
          activity: summaryData.activity,
          spike: summaryData.spike,
        }),
        notes: [],
      };
    case 'markdown':
      return { output: renderMarkdownSummaryReport(summaryData), notes: [] };
    case 'terminal':
      return renderTerminalSummaryReport(summaryData, options);
  }
}

export function renderSummaryReport(
  summaryData: SummaryDataResult,
  format: SummaryReportFormat,
  options: RenderSummaryReportOptions = {},
): string {
  return renderSummaryReportWithNotes(summaryData, format, options).output;
}
