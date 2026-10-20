import { renderCompareReport, type CompareReportFormat } from '../render/render-compare-report.js';
import { buildCompareData } from './build-compare-data.js';
import {
  emitLimitNote,
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { BuildCompareDataDeps, CompareCommandOptions } from './usage-data-contracts.js';
import { hasCliFilters } from './filter-match-warnings.js';
import { buildShareReportArtifact, parseReportJsonEnvelope } from './share-report-artifact.js';

const compareReportFormats = STANDARD_REPORT_FORMATS satisfies readonly CompareReportFormat[];

async function prepareCompareReport(
  options: CompareCommandOptions,
  deps: BuildCompareDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: compareReportFormats,
    buildData: () => buildCompareData(options, deps),
    getDiagnostics: (compareData) => ({
      ...compareData.diagnostics,
      limitNote: compareData.limitNote,
    }),
    runtimeProfile: deps.runtimeProfile,
    buildShare: async (compareData, { runtimeProfile }) => {
      const { current, baseline } = compareData;
      // The file spans both windows and opens on the current one.
      const window = {
        since: [current.window.since, baseline.window.since].sort()[0],
        until: [current.window.until, baseline.window.until].sort()[1],
      };

      return buildShareReportArtifact(
        {
          command: 'compare',
          options,
          window,
          initialView: {
            since: current.window.since,
            until: current.window.until,
            granularity: 'day',
          },
          envelope: parseReportJsonEnvelope(renderCompareReport(compareData, 'json')),
          fileBaseName: 'compare-share',
          logLabel: 'compare',
        },
        { ...deps, runtimeProfile },
      );
    },
    render: (compareData, format) =>
      renderCompareReport(compareData, format, { filtered: hasCliFilters(options) }),
  });
}

export async function buildCompareReport(
  options: CompareCommandOptions,
  deps: BuildCompareDataDeps = {},
): Promise<string> {
  const preparedReport = await prepareCompareReport(options, deps);
  return preparedReport.output;
}

export async function runCompareReport(options: CompareCommandOptions): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareCompareReport(options, { runtimeProfile });

  await runStandardPreparedReport({ preparedReport, emitReportDiagnostics: emitLimitNote });
}
