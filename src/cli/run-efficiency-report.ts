import { renderEfficiencyMonthlyShareSvg } from '../render/render-efficiency-share-svg.js';
import {
  renderEfficiencyReport,
  type EfficiencyReportFormat,
} from '../render/render-efficiency-report.js';
import { logger } from '../utils/logger.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { buildEfficiencyData } from './build-efficiency-data.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { prepareReport, runPreparedReport } from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { EfficiencyCommandOptions, EfficiencyDiagnostics } from './usage-data-contracts.js';
import type { BuildEfficiencyDataDeps } from './build-efficiency-data.js';

const efficiencyReportFormats = [
  'terminal',
  'markdown',
  'json',
] as const satisfies readonly EfficiencyReportFormat[];

function validateShareOption(
  granularity: ReportGranularity,
  options: EfficiencyCommandOptions,
): void {
  if (!options.share) {
    return;
  }

  if (granularity !== 'monthly') {
    throw new Error('--share is only supported for efficiency monthly');
  }

  if (options.bySource) {
    throw new Error('--share cannot be combined with --by-source');
  }
}

async function prepareEfficiencyReport(
  granularity: ReportGranularity,
  options: EfficiencyCommandOptions,
  deps: BuildEfficiencyDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: efficiencyReportFormats,
    validate: () => {
      validateShareOption(granularity, options);
    },
    buildData: () => buildEfficiencyData(granularity, options, deps),
    getDiagnostics: (efficiencyData) => efficiencyData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    createShareArtifact: options.share
      ? (efficiencyData) => ({
          fileName: 'efficiency-monthly-share.svg',
          svg: renderEfficiencyMonthlyShareSvg(efficiencyData),
          logLabel: 'efficiency',
        })
      : undefined,
    render: (efficiencyData, format) =>
      renderEfficiencyReport(efficiencyData, format, {
        granularity,
      }),
  });
}

function emitEfficiencyReportDiagnostics(diagnostics: EfficiencyDiagnostics): void {
  const mergeModeLabel = diagnostics.includeMergeCommits
    ? 'including merge commits'
    : 'excluding merge commits';

  logger.info(
    `Git outcomes (${mergeModeLabel}): ${diagnostics.gitCommitCount} commit(s), +${diagnostics.gitLinesAdded}/-${diagnostics.gitLinesDeleted} lines (${diagnostics.repoDir})`,
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

  await runPreparedReport<EfficiencyDiagnostics, EfficiencyReportFormat>({
    preparedReport,
    emitCommonDiagnostics: (diagnostics) => {
      emitDiagnostics(diagnostics);
    },
    getEnvVarOverrides: (diagnostics) => diagnostics.activeEnvOverrides,
    getActiveConfig: (diagnostics) => diagnostics.activeConfig,
    emitReportDiagnostics: emitEfficiencyReportDiagnostics,
    getRuntimeProfile: (diagnostics) => diagnostics.runtimeProfile,
    warnOnTerminalOverflow: true,
  });
}
