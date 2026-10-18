import {
  renderEfficiencyReportWithNotes,
  type EfficiencyReportFormat,
} from '../render/render-efficiency-report.js';
import { attributeUsageEventsToRepo } from '../efficiency/repo-attribution.js';
import { logger } from '../utils/logger.js';
import { pluralize } from '@ayagmar/agent-sessions/internal';
import { getPeriodKey, type ReportGranularity } from '../utils/time-buckets.js';
import {
  buildEfficiencyData,
  hasMeaningfulEfficiencyUsageSignal,
} from './build-efficiency-data.js';
import {
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import { hasCliFilters } from './filter-match-warnings.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import {
  buildShareReportArtifact,
  parseReportJsonEnvelope,
  toShareDateRange,
  toShareGranularity,
} from './share-report-artifact.js';
import type { EfficiencyCommandOptions, EfficiencyDiagnostics } from './usage-data-contracts.js';
import type { BuildEfficiencyDataDeps } from './build-efficiency-data.js';

const efficiencyReportFormats = STANDARD_REPORT_FORMATS satisfies readonly EfficiencyReportFormat[];

async function prepareEfficiencyReport(
  granularity: ReportGranularity,
  options: EfficiencyCommandOptions,
  deps: BuildEfficiencyDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: efficiencyReportFormats,
    buildData: () => buildEfficiencyData(granularity, options, deps),
    getDiagnostics: (efficiencyData) => efficiencyData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    buildShare: async (efficiencyData, { runtimeProfile }) => {
      const window = toShareDateRange(options.since, options.until);

      return buildShareReportArtifact(
        {
          command: 'efficiency',
          options,
          window,
          initialView: { ...window, granularity: toShareGranularity(granularity) },
          envelope: parseReportJsonEnvelope(
            renderEfficiencyReportWithNotes(efficiencyData, 'json', { granularity }).output,
          ),
          fileBaseName: `efficiency-${granularity}-share`,
          logLabel: 'efficiency',
          // The report counts its repository's usage in periods with commits; so does the file.
          scopeEvents: async (events, timezone) => {
            const reportedPeriods = new Set(
              efficiencyData.rows.flatMap((row) => (row.rowType === 'period' ? row.periodKey : [])),
            );
            const { matchedSourceEvents } = await attributeUsageEventsToRepo(
              events,
              options.repoDir?.trim() ?? process.cwd(),
              deps.resolveRepoRoot,
            );

            return matchedSourceEvents.filter(
              (event) =>
                hasMeaningfulEfficiencyUsageSignal(event) &&
                reportedPeriods.has(getPeriodKey(event.timestamp, granularity, timezone)),
            );
          },
        },
        { ...deps, runtimeProfile },
      );
    },
    render: (efficiencyData, format) => {
      const { output, notes } = renderEfficiencyReportWithNotes(efficiencyData, format, {
        granularity,
        filtered: hasCliFilters(options),
      });

      return { output, hintsAfterOutput: notes };
    },
  });
}

function emitEfficiencyReportDiagnostics(diagnostics: EfficiencyDiagnostics): void {
  const mergeModeLabel = diagnostics.includeMergeCommits
    ? 'including merge commits'
    : 'excluding merge commits';

  logger.info(
    `Git outcomes (${mergeModeLabel}): ${pluralize(diagnostics.gitCommitCount, 'commit')}, +${diagnostics.gitLinesAdded}/-${diagnostics.gitLinesDeleted} lines (${diagnostics.repoDir})`,
  );
  logger.info(
    `Repo-attributed usage events: ${diagnostics.repoMatchedUsageEvents} matched, ${diagnostics.repoExcludedUsageEvents} excluded, ${diagnostics.repoUnattributedUsageEvents} unattributed`,
  );

  if (diagnostics.scopeNote) {
    logger.warn(diagnostics.scopeNote);
  }

  if (diagnostics.gitMalformedCommitLines > 0) {
    logger.warn(
      `Skipped ${diagnostics.gitMalformedCommitLines} malformed git commit boundar${
        diagnostics.gitMalformedCommitLines === 1 ? 'y' : 'ies'
      }`,
    );
  }
}

export async function buildEfficiencyReport(
  granularity: ReportGranularity,
  options: EfficiencyCommandOptions,
): Promise<string> {
  const preparedReport = await prepareEfficiencyReport(granularity, options);
  return preparedReport.output;
}

export async function runEfficiencyReport(
  granularity: ReportGranularity,
  options: EfficiencyCommandOptions,
): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareEfficiencyReport(granularity, options, { runtimeProfile });

  await runStandardPreparedReport({
    preparedReport,
    emitReportDiagnostics: emitEfficiencyReportDiagnostics,
  });
}
