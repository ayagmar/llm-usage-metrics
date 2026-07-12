import { renderCompareReport, type CompareReportFormat } from '../render/render-compare-report.js';
import { renderCompareShareSvg } from '../render/render-compare-share-svg.js';
import { buildCompareData } from './build-compare-data.js';
import {
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { BuildCompareDataDeps, CompareCommandOptions } from './usage-data-contracts.js';

const compareReportFormats = STANDARD_REPORT_FORMATS satisfies readonly CompareReportFormat[];

async function prepareCompareReport(
  options: CompareCommandOptions,
  deps: BuildCompareDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: compareReportFormats,
    buildData: () => buildCompareData(options, deps),
    getDiagnostics: (compareData) => compareData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    createShareArtifact: options.share
      ? (compareData) => ({
          fileName: 'compare-share.svg',
          svg: renderCompareShareSvg(compareData),
          logLabel: 'compare',
        })
      : undefined,
    render: (compareData, format) => renderCompareReport(compareData, format),
  });
}

export async function buildCompareReport(options: CompareCommandOptions): Promise<string> {
  const preparedReport = await prepareCompareReport(options);
  return preparedReport.output;
}

export async function runCompareReport(options: CompareCommandOptions): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareCompareReport(options, { runtimeProfile });

  await runStandardPreparedReport({ preparedReport });
}
