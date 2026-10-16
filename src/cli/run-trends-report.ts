import { renderTrendsReport, type TrendsReportFormat } from '../render/render-trends-report.js';
import { buildTrendsData } from './build-trends-data.js';
import {
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import { buildShareReportArtifact } from './share-report-artifact.js';
import type { BuildTrendsDataDeps, TrendsCommandOptions } from './usage-data-contracts.js';

const trendsReportFormats = STANDARD_REPORT_FORMATS satisfies readonly TrendsReportFormat[];

async function prepareTrendsReport(options: TrendsCommandOptions, deps: BuildTrendsDataDeps = {}) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: trendsReportFormats,
    buildData: () => buildTrendsData(options, deps),
    getDiagnostics: (trendsData) => trendsData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    buildShare: async (trendsData, { runtimeProfile }) => {
      const window = { since: trendsData.dateRange.from, until: trendsData.dateRange.to };

      return buildShareReportArtifact(
        {
          command: 'trends',
          options,
          window,
          initialView: { ...window, granularity: 'day' },
          fileBaseName: 'trends-share',
          logLabel: 'trends',
        },
        { ...deps, runtimeProfile },
      );
    },
    render: (trendsData, format) => renderTrendsReport(trendsData, format),
  });
}

export async function buildTrendsReport(
  options: TrendsCommandOptions,
  deps: BuildTrendsDataDeps = {},
): Promise<string> {
  const preparedReport = await prepareTrendsReport(options, deps);
  return preparedReport.output;
}

export async function runTrendsReport(options: TrendsCommandOptions): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareTrendsReport(options, { runtimeProfile });

  // Trends never warned on terminal overflow; keep stderr byte-identical.
  await runStandardPreparedReport({ preparedReport, warnOnTerminalOverflow: false });
}
