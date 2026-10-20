import { getYearDateRange } from '../wrapped/aggregate-wrapped.js';
import {
  renderWrappedReport,
  renderWrappedReportWithNotes,
  wrappedReportFormats,
} from '../render/render-wrapped-report.js';
import { buildWrappedData, parseWrappedYearOption } from './build-wrapped-data.js';
import { prepareReport, runStandardPreparedReport } from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { BuildWrappedDataDeps, WrappedCommandOptions } from './usage-data-contracts.js';
import { hasCliFilters } from './filter-match-warnings.js';
import { buildShareReportArtifact, parseReportJsonEnvelope } from './share-report-artifact.js';

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
    buildShare: async (wrappedData, { runtimeProfile }) => {
      const { year } = wrappedData.recap;
      // The file holds the year and opens on all of it.
      const { from: since, to: until } = getYearDateRange(year);
      const window = { since, until };

      return buildShareReportArtifact(
        {
          command: 'wrapped',
          options,
          window,
          initialView: { ...window, granularity: 'week' },
          envelope: parseReportJsonEnvelope(renderWrappedReport(wrappedData.recap, 'json')),
          fileBaseName: `llm-usage-wrapped-${year}`,
          logLabel: 'wrapped',
        },
        { ...deps, runtimeProfile },
      );
    },
    render: (wrappedData, format) => {
      const { output, notes } = renderWrappedReportWithNotes(wrappedData.recap, format, {
        filtered: hasCliFilters(options),
      });

      return { output, hintsAfterOutput: notes };
    },
  });
}

export async function buildWrappedReport(options: WrappedCommandOptions): Promise<string> {
  const preparedReport = await prepareWrappedReport(options);
  return preparedReport.output;
}

export async function runWrappedReport(options: WrappedCommandOptions): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareWrappedReport(options, { runtimeProfile });

  // Wrapped never warned on terminal overflow; keep stderr byte-identical.
  await runStandardPreparedReport({ preparedReport, warnOnTerminalOverflow: false });
}
