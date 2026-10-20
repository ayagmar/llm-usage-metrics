import { markdownTable } from 'markdown-table';
import pc from 'picocolors';

import type {
  ValueMonthRow,
  ValuePlanReport,
  ValueReportData,
} from '../value/build-value-report.js';
import {
  formatAbbreviatedTokenCount,
  formatApproxUsd,
  formatInteger,
  formatSharePercent,
  formatUsd,
} from './format-number.js';
import { toMarkdownSafeCell } from './markdown-safe-cell.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import {
  padEndVisible,
  padStartVisible,
  resolveTtyColumns,
  splitCellLines,
  visibleWidth,
  wrapProse,
} from './table-text-layout.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import {
  describeTableFit,
  type RenderedReportWithNotes,
  type TableFitChanges,
} from './table-fit-note.js';
import { createColorRoles } from './terminal-style-policy.js';
import { renderUnicodeTableWithFit, type TableRowMeta } from './unicode-table.js';

export type ValueReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderValueReportOptions = {
  /** `--compact`: abbreviated token counts without the Difference column. */
  compact?: boolean;
  /** `--no-cost`: leaves out every price and cost. */
  hideCost?: boolean;
  /** Whether filters were passed, for the empty-report message. */
  filtered?: boolean;
  useColor?: boolean;
  terminalWidth?: number;
};

type ValueColumn = 'month' | 'projects' | 'tokens' | 'apiCost' | 'plan' | 'ratio' | 'difference';

const COLUMN_HEADERS: Record<ValueColumn, string> = {
  month: 'Month',
  projects: 'Projects',
  tokens: 'Tokens',
  apiCost: 'API Cost',
  plan: 'Plan',
  ratio: 'API / Plan',
  difference: 'Difference',
};

const PARTIAL_MONTH_MARKER = '*';

function formatRatio(value: number | null, incomplete: boolean): string {
  return value === null ? '-' : `${incomplete ? '~' : ''}${value.toFixed(2)}x`;
}

function resolveColumns(options: RenderValueReportOptions): ValueColumn[] {
  if (options.hideCost) {
    return ['month', 'projects', 'tokens'];
  }

  const columns: ValueColumn[] = ['month', 'projects', 'tokens', 'apiCost', 'plan', 'ratio'];
  return options.compact ? columns : [...columns, 'difference'];
}

/** One line per listed project, then one for the projects --top left out. */
function formatProjects(
  month: ValueMonthRow,
  options: RenderValueReportOptions & { align: boolean },
): string {
  const entries = month.projects.map((project) => ({
    label: project.project,
    cost: formatApproxUsd(project.costUsd, project.costIncomplete),
    share: `(${formatSharePercent(project.costShare)})`,
  }));
  const { otherProjects } = month;

  if (otherProjects !== null) {
    entries.push({
      label: `and ${formatInteger(otherProjects.projects)} more`,
      cost: formatApproxUsd(otherProjects.costUsd, otherProjects.costIncomplete),
      share: `(${formatSharePercent(otherProjects.costShare)})`,
    });
  }

  if (entries.length === 0) {
    return '-';
  }

  if (options.hideCost) {
    return entries.map((entry) => `• ${entry.label}`).join('\n');
  }

  if (!options.align) {
    return entries.map((entry) => `• ${entry.label} ${entry.cost} ${entry.share}`).join('\n');
  }

  const widest = (values: string[]): number =>
    values.reduce((max, value) => Math.max(max, visibleWidth(value)), 0);
  const labelWidth = widest(entries.map((entry) => entry.label));
  const costWidth = widest(entries.map((entry) => entry.cost));
  const shareWidth = widest(entries.map((entry) => entry.share));

  return entries
    .map(
      (entry) =>
        `• ${padEndVisible(entry.label, labelWidth)}  ${padStartVisible(entry.cost, costWidth)} ${padStartVisible(entry.share, shareWidth)}`,
    )
    .join('\n');
}

type ValueTableRow = {
  meta: TableRowMeta;
  cells: Record<ValueColumn, string>;
};

function toTableRows(
  plan: ValuePlanReport,
  options: RenderValueReportOptions & { useColor: boolean; align: boolean },
): ValueTableRow[] {
  const formatTokens = options.compact ? formatAbbreviatedTokenCount : formatInteger;
  const { money, moneyTotal } = createColorRoles(options.useColor);
  const styleDifference = (value: number, formatted: string): string => {
    if (!options.useColor || value === 0) {
      return formatted;
    }

    return value > 0 ? pc.green(formatted) : pc.red(formatted);
  };

  const monthRows = plan.months.map((month) => ({
    meta: { periodKey: month.month, rowKind: 'detail' as const },
    cells: {
      month: month.partial ? `${month.month}${PARTIAL_MONTH_MARKER}` : month.month,
      projects: formatProjects(month, options),
      tokens: formatTokens(month.totalTokens),
      apiCost: money(formatApproxUsd(month.apiCostUsd, month.costIncomplete)),
      plan: money(formatUsd(month.planPriceUsd)),
      ratio: formatRatio(month.ratio, month.costIncomplete),
      difference: styleDifference(
        month.differenceUsd,
        formatApproxUsd(month.differenceUsd, month.costIncomplete),
      ),
    },
  }));
  const { total } = plan;
  const totalLabel = options.useColor ? pc.bold('ALL') : 'ALL';

  return [
    ...monthRows,
    {
      meta: { periodKey: 'ALL', periodGroup: 'summary', rowKind: 'total' },
      cells: {
        month: totalLabel,
        projects: '',
        tokens: formatTokens(total.totalTokens),
        apiCost: moneyTotal(formatApproxUsd(total.apiCostUsd, total.costIncomplete)),
        plan: moneyTotal(formatUsd(total.planPriceUsd)),
        ratio: formatRatio(total.ratio, total.costIncomplete),
        difference: styleDifference(
          total.differenceUsd,
          formatApproxUsd(total.differenceUsd, total.costIncomplete),
        ),
      },
    },
  ];
}

function describePlan(plan: ValuePlanReport, asOf: string, hideCost: boolean): string {
  const sources = `sources: ${plan.sources.join(', ')}`;

  if (hideCost) {
    return `${plan.id} (${sources})`;
  }

  const price =
    plan.priceSource === 'override'
      ? `${formatUsd(plan.priceUsdPerMonth)}/month from --plan-price (list price ${formatUsd(plan.listPriceUsdPerMonth)} as of ${asOf})`
      : `${formatUsd(plan.priceUsdPerMonth)}/month list price as of ${asOf}`;

  return `${plan.id}: ${price}, ${sources}`;
}

/** Lines under the tables: the legend and where to check the prices. */
function buildFooterLines(data: ValueReportData, options: RenderValueReportOptions): string[] {
  const lines: string[] = [];

  if (data.plans.some((plan) => plan.months.some((month) => month.partial))) {
    lines.push(
      `Months marked ${PARTIAL_MONTH_MARKER} are partial: the window does not cover all of the month, or it is the current month (not prorated)`,
    );
  }

  if (!options.hideCost) {
    const legend = 'API Cost is the estimated pay-as-you-go price of the same usage';
    lines.push(
      options.compact
        ? legend
        : `${legend}; Difference = API Cost - Plan (positive: the plan cost less)`,
    );
  }

  const checkAt = [...new Set(data.plans.flatMap((plan) => plan.checkAt))];
  lines.push(
    `Plan prices as of ${data.asOf}, USD per month excluding tax; check current prices at ${checkAt.join(', ')}`,
  );

  return lines;
}

function hasNoMonths(data: ValueReportData): boolean {
  return data.plans.every((plan) => plan.months.length === 0);
}

function renderTerminalValueReport(
  data: ValueReportData,
  options: RenderValueReportOptions,
): RenderedReportWithNotes {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const columns = resolveColumns(options);
  const headerCells = columns.map((column) => COLUMN_HEADERS[column]);
  const lines = [renderReportHeader({ title: 'Plan Value Report (estimated)', useColor }), ''];

  if (hasNoMonths(data)) {
    lines.push(formatNoUsageMessage(options.filtered ?? false));
    return { output: lines.join('\n'), notes: [] };
  }

  const fits: TableFitChanges[] = [];
  const roles = createColorRoles(useColor);
  const terminalWidth = options.terminalWidth ?? resolveTtyColumns(process.stdout);

  for (const plan of data.plans) {
    const rows = toTableRows(plan, { ...options, useColor, align: true });
    const bodyRows = rows.map((row) => columns.map((column) => row.cells[column]));
    const description = describePlan(plan, data.asOf, options.hideCost === true);

    lines.push(useColor ? pc.cyan(description) : description);
    const { output, fit } = renderUnicodeTableWithFit({
      labelStyler: roles.label,
      headerCells: headerCells.map((header) => roles.header(header)),
      bodyRows,
      measureHeaderCells: headerCells,
      measureBodyRows: bodyRows,
      rowMetas: rows.map((row) => row.meta),
      columnKinds: columns.map((column) =>
        column === 'month' || column === 'projects' ? 'text' : 'measure',
      ),
      multilineColumnIndex: 1,
      // Narrow terminals list each project on its own line, not in the month's title.
      stackedTitleColumnCount: 1,
      terminalWidth,
    });

    lines.push(output, '');
    fits.push(fit);
  }

  // Dim each line on its own, so no style carries across a wrapped line.
  const footerLines = buildFooterLines(data, options).flatMap((line) =>
    splitCellLines(wrapProse(line, terminalWidth)),
  );
  lines.push(...(useColor ? footerLines.map((line) => pc.dim(line)) : footerLines));

  const fitNote = describeTableFit(...fits);

  return { output: lines.join('\n'), notes: fitNote ? [fitNote] : [] };
}

function renderMarkdownValueReport(
  data: ValueReportData,
  options: RenderValueReportOptions,
): string {
  if (hasNoMonths(data)) {
    return formatNoUsageMessage(options.filtered ?? false);
  }

  const columns = resolveColumns(options);
  const headerCells = columns.map((column) => COLUMN_HEADERS[column]);
  const alignment = columns.map((_, index) => (index <= 1 ? 'l' : 'r'));
  const sections = data.plans.map((plan) => {
    const bodyRows = toTableRows(plan, { ...options, useColor: false, align: false }).map((row) =>
      columns.map((column) => toMarkdownSafeCell(row.cells[column])),
    );

    return [
      // Plan ids, prices and source ids only: no user text to escape.
      describePlan(plan, data.asOf, options.hideCost === true),
      '',
      markdownTable([headerCells, ...bodyRows], { align: alignment }),
    ].join('\n');
  });
  const footer = buildFooterLines(data, options);

  return [...sections, footer.join('\n\n')].join('\n\n');
}

export function renderValueReportWithNotes(
  data: ValueReportData,
  format: ValueReportFormat,
  options: RenderValueReportOptions = {},
): RenderedReportWithNotes {
  switch (format) {
    case 'json':
      return { output: renderReportJson('value', data), notes: [] };
    case 'markdown':
      return { output: renderMarkdownValueReport(data, options), notes: [] };
    case 'terminal':
      return renderTerminalValueReport(data, options);
  }
}

export function renderValueReport(
  data: ValueReportData,
  format: ValueReportFormat,
  options: RenderValueReportOptions = {},
): string {
  return renderValueReportWithNotes(data, format, options).output;
}
