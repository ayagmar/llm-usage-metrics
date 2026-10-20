import type { UsageDataResult } from '../cli/usage-data-contracts.js';
import type { UsageGranularity } from '../utils/time-buckets.js';
import { renderMarkdownTable } from './markdown-table.js';
import { formatNoUsageMessage, renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import { describeTableFit } from './table-fit-note.js';
import {
  compactHiddenUsageColumns,
  getUsageTableHeader,
  type UsageTableLayout,
} from './row-cells.js';
import {
  renderTerminalTableWithFit,
  shouldUseColorByDefault,
  type TerminalTableFit,
} from './terminal-table.js';

export type UsageReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderUsageReportOptions = {
  granularity: UsageGranularity;
  useColor?: boolean;
  tableLayout?: UsageTableLayout;
  /** `--compact`: abbreviated token counts without the Reasoning and Cache Write columns. */
  compact?: boolean;
  /** `--no-cost`: leave out the Cost column. */
  hideCost?: boolean;
  terminalWidth?: number;
  /** Whether the command line narrowed the report; names the filters in the empty message. */
  filtered?: boolean;
};

export type RenderedUsageReport = {
  output: string;
  /** stderr notes about what a narrow terminal left out of the table. */
  notes: string[];
};

function getReportTitle(granularity: UsageGranularity): string {
  switch (granularity) {
    case 'hourly':
      return 'Hourly Token Usage Report';
    case 'daily':
      return 'Daily Token Usage Report';
    case 'weekly':
      return 'Weekly Token Usage Report';
    case 'monthly':
      return 'Monthly Token Usage Report';
  }
}

/** Describes what the terminal fit changed beyond what --compact and --no-cost asked for. */
export function describeUsageTableFit(
  fit: TerminalTableFit,
  compact: boolean,
  hideCost = false,
): string | undefined {
  const impliedHiddenColumns = [
    ...(compact ? compactHiddenUsageColumns : []),
    ...(hideCost ? (['cost'] as const) : []),
  ];

  return describeTableFit({
    abbreviatedTokens: !compact && fit.tokenFormat === 'abbreviated',
    hiddenHeaders: fit.hiddenColumns
      .filter((column) => !impliedHiddenColumns.includes(column))
      .map((column) => getUsageTableHeader(column)),
    shortenedModelNames: fit.truncatedModelNames,
    stacked: fit.stacked,
  });
}

function renderTerminalUsageReport(
  usageData: UsageDataResult,
  options: RenderUsageReportOptions,
): RenderedUsageReport {
  const outputLines: string[] = [];
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const tableLayout = options.tableLayout ?? 'compact';

  outputLines.push(
    renderReportHeader({
      title: getReportTitle(options.granularity),
      useColor,
      terminalWidth: options.terminalWidth,
    }),
  );

  outputLines.push('');

  // An empty report still carries its zero grand total row.
  if (usageData.rows.every((row) => row.rowType === 'grand_total')) {
    outputLines.push(formatNoUsageMessage(options.filtered ?? false));
    return { output: outputLines.join('\n'), notes: [] };
  }

  const { output, fit } = renderTerminalTableWithFit(usageData.rows, {
    useColor,
    tableLayout,
    compact: options.compact,
    hideCost: options.hideCost,
    terminalWidth: options.terminalWidth,
  });
  const fitNote = describeUsageTableFit(fit, options.compact ?? false, options.hideCost);

  outputLines.push(output);

  return { output: outputLines.join('\n'), notes: fitNote ? [fitNote] : [] };
}

export function renderUsageReportWithNotes(
  usageData: UsageDataResult,
  format: UsageReportFormat,
  options: RenderUsageReportOptions,
): RenderedUsageReport {
  const tableLayout = options.tableLayout ?? 'compact';

  switch (format) {
    case 'json':
      return { output: renderReportJson('usage', usageData.rows), notes: [] };
    case 'markdown':
      return {
        output: renderMarkdownTable(usageData.rows, {
          tableLayout,
          compact: options.compact,
          hideCost: options.hideCost,
        }),
        notes: [],
      };
    case 'terminal':
      return renderTerminalUsageReport(usageData, options);
  }
}
