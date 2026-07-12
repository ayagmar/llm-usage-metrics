import {
  renderWrappedReport,
  wrappedReportFormats,
  type WrappedReportFormat,
} from '../render/render-wrapped-report.js';
import { renderWrappedShareSvg } from '../render/render-wrapped-share-svg.js';
import { buildWrappedData, parseWrappedYearOption } from './build-wrapped-data.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { prepareReport, runPreparedReport } from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type {
  BuildWrappedDataDeps,
  UsageDiagnostics,
  WrappedCommandOptions,
} from './usage-data-contracts.js';

async function prepareWrappedReport(
  options: WrappedCommandOptions,
  deps: BuildWrappedDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: wrappedReportFormats,
    validate: () => {
      parseWrappedYearOption(options.year);
    },
    buildData: () => buildWrappedData(options, deps),
    getDiagnostics: (wrappedData) => wrappedData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    createShareArtifact: options.share
      ? (wrappedData) => ({
          fileName: `llm-usage-wrapped-${wrappedData.recap.year}.svg`,
          svg: renderWrappedShareSvg(wrappedData.recap),
          logLabel: 'wrapped',
        })
      : undefined,
    render: (wrappedData, format) => renderWrappedReport(wrappedData.recap, format),
  });
}

export async function buildWrappedReport(options: WrappedCommandOptions): Promise<string> {
  const preparedReport = await prepareWrappedReport(options);
  return preparedReport.output;
}

export async function runWrappedReport(options: WrappedCommandOptions): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareWrappedReport(options, { runtimeProfile });

  await runPreparedReport<UsageDiagnostics, WrappedReportFormat>({
    preparedReport,
    emitCommonDiagnostics: emitDiagnostics,
    getEnvVarOverrides: (diagnostics) => diagnostics.activeEnvOverrides,
    getActiveConfig: (diagnostics) => diagnostics.activeConfig,
    getRuntimeProfile: (diagnostics) => diagnostics.runtimeProfile,
  });
}
