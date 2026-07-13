import { buildUsageData } from './build-usage-data.js';
import {
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { BuildUsageDataDeps, ReportCommandOptions } from './usage-data-contracts.js';
import { renderUsageReport, type UsageReportFormat } from '../render/render-usage-report.js';
import { renderUsageShareSvg } from '../render/render-usage-share-svg.js';
import type { UsageTableLayout } from '../render/row-cells.js';
import type { ReportGranularity } from '../utils/time-buckets.js';

const usageReportFormats = STANDARD_REPORT_FORMATS satisfies readonly UsageReportFormat[];

function resolveTableLayout(options: ReportCommandOptions): UsageTableLayout {
  return options.perModelColumns ? 'per_model_columns' : 'compact';
}

function resolveShareFileName(granularity: ReportGranularity): string {
  return `usage-${granularity}-share.svg`;
}

async function prepareUsageReport(
  granularity: ReportGranularity,
  options: ReportCommandOptions,
  deps: BuildUsageDataDeps = {},
) {
  const tableLayout = resolveTableLayout(options);

  return prepareReport({
    commandOptions: options,
    supportedFormats: usageReportFormats,
    buildData: () => buildUsageData(granularity, options, deps),
    getDiagnostics: (usageData) => usageData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    createShareArtifact: options.share
      ? (usageData) => ({
          fileName: resolveShareFileName(granularity),
          svg: renderUsageShareSvg(usageData, granularity),
          logLabel: 'usage',
        })
      : undefined,
    render: (usageData, format) =>
      renderUsageReport(usageData, format, {
        granularity,
        tableLayout,
      }),
  });
}

export async function buildUsageReport(
  granularity: ReportGranularity,
  options: ReportCommandOptions,
): Promise<string> {
  const preparedReport = await prepareUsageReport(granularity, options);
  return preparedReport.output;
}

export async function runUsageReport(
  granularity: ReportGranularity,
  options: ReportCommandOptions,
): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareUsageReport(granularity, options, { runtimeProfile });

  await runStandardPreparedReport({ preparedReport });
}
