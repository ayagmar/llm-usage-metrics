import { renderTrendsReport, type TrendsReportFormat } from '../render/render-trends-report.js';
import { renderTrendsShareSvg } from '../render/render-trends-share-svg.js';
import { createShareCardArtifact } from '../render/render-share-page.js';
import { buildTrendsData } from './build-trends-data.js';
import {
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { BuildTrendsDataDeps, TrendsCommandOptions } from './usage-data-contracts.js';

const trendsReportFormats = STANDARD_REPORT_FORMATS satisfies readonly TrendsReportFormat[];

function validateShareOption(options: TrendsCommandOptions): void {
  if (!options.share) {
    return;
  }

  if (options.bySource) {
    throw new Error('--share does not support --by-source yet; run without --by-source');
  }
}

async function prepareTrendsReport(options: TrendsCommandOptions, deps: BuildTrendsDataDeps = {}) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: trendsReportFormats,
    validate: () => {
      validateShareOption(options);
    },
    buildData: () => buildTrendsData(options, deps),
    getDiagnostics: (trendsData) => trendsData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    buildShare: async (trendsData) =>
      createShareCardArtifact({
        fileBaseName: 'trends-share',
        logLabel: 'trends',
        title: 'Trends share card',
        renderSvg: (theme) => renderTrendsShareSvg(trendsData, theme),
      }),
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
