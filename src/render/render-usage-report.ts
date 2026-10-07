import type { UsageDataResult } from '../cli/usage-data-contracts.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { renderMarkdownTable } from './markdown-table.js';
import { renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
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
  granularity: ReportGranularity;
  useColor?: boolean;
  tableLayout?: UsageTableLayout;
  /** `--compact`: abbreviated token counts without the Reasoning and Cache Write columns. */
  compact?: boolean;
  terminalWidth?: number;
};

export type RenderedUsageReport = {
  output: string;
  /** stderr notes about what a narrow terminal left out of the table. */
  notes: string[];
};

function getReportTitle(granularity: ReportGranularity): string {
  switch (granularity) {
    case 'daily':
      return 'Daily Token Usage Report';
    case 'weekly':
      return 'Weekly Token Usage Report';
    case 'monthly':
      return 'Monthly Token Usage Report';
  }
}

function joinWithAnd(items: readonly string[]): string {
  return items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** Describes what the terminal fit changed beyond what the user asked for with --compact. */
export function describeTableFit(fit: TerminalTableFit, compact: boolean): string | undefined {
  const changes: string[] = [];

  if (!compact && fit.tokenFormat === 'abbreviated') {
    changes.push('abbreviated token counts');
  }

  const impliedHiddenColumns = compact ? compactHiddenUsageColumns : [];
  const hiddenHeaders = fit.hiddenColumns
    .filter((column) => !impliedHiddenColumns.includes(column))
    .map((column) => getUsageTableHeader(column));

  if (hiddenHeaders.length > 0) {
    changes.push(`hid ${joinWithAnd(hiddenHeaders)}`);
  }

  if (fit.truncatedModelNames) {
    changes.push('shortened model names');
  }

  if (changes.length === 0) {
    return undefined;
  }

  return `Fitted the table to the terminal: ${changes.join(', ')}. Widen the terminal or use --json for full detail.`;
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
    }),
  );

  outputLines.push('');

  if (usageData.rows.length === 0) {
    outputLines.push('No usage data found for the selected filters.');
    return { output: outputLines.join('\n'), notes: [] };
  }

  const { output, fit } = renderTerminalTableWithFit(usageData.rows, {
    useColor,
    tableLayout,
    compact: options.compact,
    terminalWidth: options.terminalWidth,
  });
  const fitNote = describeTableFit(fit, options.compact ?? false);

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
        output: renderMarkdownTable(usageData.rows, { tableLayout, compact: options.compact }),
        notes: [],
      };
    case 'terminal':
      return renderTerminalUsageReport(usageData, options);
  }
}

export function renderUsageReport(
  usageData: UsageDataResult,
  format: UsageReportFormat,
  options: RenderUsageReportOptions,
): string {
  return renderUsageReportWithNotes(usageData, format, options).output;
}
