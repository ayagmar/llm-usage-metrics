import { renderTrendsReport, type TrendsReportFormat } from '../render/render-trends-report.js';
import { buildTrendsData } from './build-trends-data.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { prepareReport, runPreparedReport } from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { TrendsCommandOptions, UsageDiagnostics } from './usage-data-contracts.js';

const trendsReportFormats = ['terminal', 'json'] as const satisfies readonly TrendsReportFormat[];

async function prepareTrendsReport(
  options: TrendsCommandOptions,
  deps: Parameters<typeof buildTrendsData>[1] = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: trendsReportFormats,
    buildData: () => buildTrendsData(options, deps),
    getDiagnostics: (trendsData) => trendsData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    render: (trendsData, format) => renderTrendsReport(trendsData, format),
  });
}

export async function buildTrendsReport(options: TrendsCommandOptions): Promise<string> {
  const preparedReport = await prepareTrendsReport(options);
  return preparedReport.output;
}

export async function runTrendsReport(options: TrendsCommandOptions): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareTrendsReport(options, { runtimeProfile });

  await runPreparedReport<UsageDiagnostics, TrendsReportFormat>({
    preparedReport,
    emitCommonDiagnostics: emitDiagnostics,
    getEnvVarOverrides: (diagnostics) => diagnostics.activeEnvOverrides,
    getRuntimeProfile: (diagnostics) => diagnostics.runtimeProfile,
  });
}
