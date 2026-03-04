import { renderEfficiencyMonthlyShareSvg } from '../render/render-efficiency-share-svg.js';
import { buildEfficiencyData } from './build-efficiency-data.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { emitEnvVarOverrides } from './emit-env-var-overrides.js';
import { openShareSvgFile, writeShareSvgFile } from './share-artifact.js';
import { warnIfTerminalTableOverflows } from './terminal-overflow-warning.js';
import type { EfficiencyCommandOptions, EfficiencyDiagnostics } from './usage-data-contracts.js';
import {
  renderEfficiencyReport,
  type EfficiencyReportFormat,
} from '../render/render-efficiency-report.js';
import { logger } from '../utils/logger.js';
import type { ReportGranularity } from '../utils/time-buckets.js';

type PreparedEfficiencyReport = {
  format: EfficiencyReportFormat;
  output: string;
  diagnostics: EfficiencyDiagnostics;
  shareSvg?: string;
};

function validateOutputFormatOptions(options: EfficiencyCommandOptions): void {
  if (options.markdown && options.json) {
    throw new Error('Choose either --markdown or --json, not both');
  }
}

function resolveReportFormat(options: EfficiencyCommandOptions): EfficiencyReportFormat {
  if (options.json) {
    return 'json';
  }

  if (options.markdown) {
    return 'markdown';
  }

  return 'terminal';
}

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
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function prepareEfficiencyReport(
  granularity: ReportGranularity,
  options: EfficiencyCommandOptions,
): Promise<PreparedEfficiencyReport> {
  validateOutputFormatOptions(options);
  validateShareOption(granularity, options);

  const efficiencyData = await buildEfficiencyData(granularity, options);
  const format = resolveReportFormat(options);

  return {
    format,
    diagnostics: efficiencyData.diagnostics,
    shareSvg: options.share ? renderEfficiencyMonthlyShareSvg(efficiencyData) : undefined,
    output: renderEfficiencyReport(efficiencyData, format, {
      granularity,
    }),
  };
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
  const preparedReport = await prepareEfficiencyReport(granularity, options);

  emitDiagnostics(preparedReport.diagnostics.usage, logger);
  emitEnvVarOverrides(preparedReport.diagnostics.usage.activeEnvOverrides, logger);

  const mergeModeLabel = preparedReport.diagnostics.includeMergeCommits
    ? 'including merge commits'
    : 'excluding merge commits';
  logger.info(
    `Git outcomes (${mergeModeLabel}): ${preparedReport.diagnostics.gitCommitCount} commit(s), +${preparedReport.diagnostics.gitLinesAdded}/-${preparedReport.diagnostics.gitLinesDeleted} lines (${preparedReport.diagnostics.repoDir})`,
  );
  logger.info(
    `Repo-attributed usage events: ${preparedReport.diagnostics.repoMatchedUsageEvents} matched, ${preparedReport.diagnostics.repoExcludedUsageEvents} excluded, ${preparedReport.diagnostics.repoUnattributedUsageEvents} unattributed`,
  );

  if (preparedReport.diagnostics.scopeNote) {
    logger.warn(preparedReport.diagnostics.scopeNote);
  }

  if (preparedReport.format === 'terminal') {
    warnIfTerminalTableOverflows(preparedReport.output, (message) => {
      logger.warn(message);
    });
  }

  if (preparedReport.shareSvg) {
    const outputPath = await writeShareSvgFile(
      'efficiency-monthly-share.svg',
      preparedReport.shareSvg,
    );
    logger.info(`Wrote efficiency share SVG: ${outputPath}`);

    try {
      await openShareSvgFile(outputPath);
      logger.info(`Opened efficiency share SVG: ${outputPath}`);
    } catch (error) {
      logger.warn(`Could not open efficiency share SVG: ${outputPath} (${errorMessage(error)})`);
    }
  }

  console.log(preparedReport.output);
}
