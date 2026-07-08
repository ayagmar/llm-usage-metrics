import { renderCompareReport, type CompareReportFormat } from '../render/render-compare-report.js';
import { buildCompareData } from './build-compare-data.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { prepareReport, runPreparedReport } from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type {
  BuildCompareDataDeps,
  CompareCommandOptions,
  UsageDiagnostics,
} from './usage-data-contracts.js';

const compareReportFormats = [
  'terminal',
  'markdown',
  'json',
] as const satisfies readonly CompareReportFormat[];

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

  await runPreparedReport<UsageDiagnostics, CompareReportFormat>({
    preparedReport,
    emitCommonDiagnostics: emitDiagnostics,
    getEnvVarOverrides: (diagnostics) => diagnostics.activeEnvOverrides,
    getActiveConfig: (diagnostics) => diagnostics.activeConfig,
    getRuntimeProfile: (diagnostics) => diagnostics.runtimeProfile,
    warnOnTerminalOverflow: true,
  });
}
