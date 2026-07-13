import type { UsageDataResult } from '../cli/usage-data-contracts.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { renderMarkdownTable } from './markdown-table.js';
import { renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import type { UsageTableLayout } from './row-cells.js';
import { renderTerminalTable, shouldUseColorByDefault } from './terminal-table.js';

export type UsageReportFormat = 'terminal' | 'markdown' | 'json';

export type RenderUsageReportOptions = {
  granularity: ReportGranularity;
  useColor?: boolean;
  tableLayout?: UsageTableLayout;
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

function renderTerminalUsageReport(
  usageData: UsageDataResult,
  options: RenderUsageReportOptions,
): string {
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
    return outputLines.join('\n');
  }

  outputLines.push(renderTerminalTable(usageData.rows, { useColor, tableLayout }));

  return outputLines.join('\n');
}

export function renderUsageReport(
  usageData: UsageDataResult,
  format: UsageReportFormat,
  options: RenderUsageReportOptions,
): string {
  const tableLayout = options.tableLayout ?? 'compact';

  switch (format) {
    case 'json':
      return renderReportJson('usage', usageData.rows);
    case 'markdown':
      return renderMarkdownTable(usageData.rows, { tableLayout });
    case 'terminal':
      return renderTerminalUsageReport(usageData, options);
  }
}
