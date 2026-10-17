import { renderToolsReport, type ToolsReportFormat } from '../render/render-tools-report.js';
import { buildToolsData } from './build-tools-data.js';
import { hasCliFilters } from './filter-match-warnings.js';
import {
  emitLimitNote,
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import { getDefaultWindowHint } from './run-usage-report.js';
import type { BuildUsageDataDeps, ToolsCommandOptions } from './usage-data-contracts.js';

const toolsReportFormats = STANDARD_REPORT_FORMATS satisfies readonly ToolsReportFormat[];

async function prepareToolsReport(options: ToolsCommandOptions, deps: BuildUsageDataDeps = {}) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: toolsReportFormats,
    buildData: () => buildToolsData(options, deps),
    getDiagnostics: (toolsData) => ({ ...toolsData.diagnostics, limitNote: toolsData.limitNote }),
    runtimeProfile: deps.runtimeProfile,
    render: (toolsData, format) =>
      renderToolsReport(toolsData, format, { filtered: hasCliFilters(options) }),
    getHintsAfterOutput: (toolsData) =>
      toolsData.defaultWindowSince
        ? getDefaultWindowHint('daily', toolsData.defaultWindowSince, {
            label: 'tool calls',
            older: 'calls',
          })
        : [],
  });
}

export async function buildToolsReport(
  options: ToolsCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<string> {
  const preparedReport = await prepareToolsReport(options, deps);
  return preparedReport.output;
}

export async function runToolsReport(
  options: ToolsCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareToolsReport(options, { ...deps, runtimeProfile });

  await runStandardPreparedReport({
    preparedReport,
    emitReportDiagnostics: emitLimitNote,
  });
}
