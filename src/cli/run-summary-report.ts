import { renderSummaryReport, type SummaryReportFormat } from '../render/render-summary-report.js';
import { renderSummaryShareSvg } from '../render/render-summary-share-svg.js';
import { buildSummaryData } from './build-summary-data.js';
import {
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { BuildSummaryDataDeps, SummaryCommandOptions } from './usage-data-contracts.js';

const summaryReportFormats = STANDARD_REPORT_FORMATS satisfies readonly SummaryReportFormat[];

export const SUMMARY_NEXT_STEPS_HINT =
  'More detail: llm-usage daily · llm-usage monthly · llm-usage compare · llm-usage --help';

async function prepareSummaryReport(
  options: SummaryCommandOptions,
  deps: BuildSummaryDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: summaryReportFormats,
    buildData: () => buildSummaryData(options, deps),
    getDiagnostics: (summaryData) => summaryData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    createShareArtifact: options.share
      ? (summaryData) => ({
          fileName: 'summary-share.svg',
          logLabel: 'summary',
          title: 'Activity share card',
          render: (theme) => renderSummaryShareSvg(summaryData, theme),
        })
      : undefined,
    render: (summaryData, format) => renderSummaryReport(summaryData, format),
    getHintsAfterOutput: (_summaryData, format) =>
      format === 'terminal' ? [SUMMARY_NEXT_STEPS_HINT] : [],
  });
}

export async function buildSummaryReport(
  options: SummaryCommandOptions,
  deps: BuildSummaryDataDeps = {},
): Promise<string> {
  const preparedReport = await prepareSummaryReport(options, deps);
  return preparedReport.output;
}

export async function runSummaryReport(options: SummaryCommandOptions): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareSummaryReport(options, { runtimeProfile });

  await runStandardPreparedReport({ preparedReport });
}
