import { logger } from '../utils/logger.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { renderOptimizeMonthlyShareSvg } from '../render/render-optimize-share-svg.js';
import {
  renderOptimizeReport,
  type OptimizeReportFormat,
} from '../render/render-optimize-report.js';
import { buildOptimizeData } from './build-optimize-data.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { emitEnvVarOverrides } from './emit-env-var-overrides.js';
import { writeAndOpenShareSvgFile } from './share-artifact.js';
import { warnIfTerminalTableOverflows } from './terminal-overflow-warning.js';
import type { OptimizeCommandOptions, OptimizeDiagnostics } from './usage-data-contracts.js';

type PreparedOptimizeReport = {
  format: OptimizeReportFormat;
  output: string;
  diagnostics: OptimizeDiagnostics;
  candidateCount: number;
  shareSvg?: string;
};

function validateOutputFormatOptions(options: OptimizeCommandOptions): void {
  if (options.markdown && options.json) {
    throw new Error('Choose either --markdown or --json, not both');
  }
}

function resolveReportFormat(options: OptimizeCommandOptions): OptimizeReportFormat {
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
  options: OptimizeCommandOptions,
): void {
  if (!options.share) {
    return;
  }

  if (granularity !== 'monthly') {
    throw new Error('--share is only supported for optimize monthly');
  }
}

async function prepareOptimizeReport(
  granularity: ReportGranularity,
  options: OptimizeCommandOptions,
): Promise<PreparedOptimizeReport> {
  validateOutputFormatOptions(options);
  validateShareOption(granularity, options);

  const optimizeData = await buildOptimizeData(granularity, options);
  const format = resolveReportFormat(options);

  return {
    format,
    diagnostics: optimizeData.diagnostics,
    candidateCount: optimizeData.rows.filter(
      (row) => row.rowType === 'candidate' && row.periodKey === 'ALL',
    ).length,
    shareSvg: options.share ? renderOptimizeMonthlyShareSvg(optimizeData) : undefined,
    output: renderOptimizeReport(optimizeData, format, {
      granularity,
    }),
  };
}

export async function buildOptimizeReport(
  granularity: ReportGranularity,
  options: OptimizeCommandOptions,
): Promise<string> {
  const preparedReport = await prepareOptimizeReport(granularity, options);
  return preparedReport.output;
}

export async function runOptimizeReport(
  granularity: ReportGranularity,
  options: OptimizeCommandOptions,
): Promise<void> {
  const preparedReport = await prepareOptimizeReport(granularity, options);

  emitDiagnostics(preparedReport.diagnostics.usage, logger);
  emitEnvVarOverrides(preparedReport.diagnostics.usage.activeEnvOverrides, logger);

  logger.info(
    `Optimize provider scope: ${preparedReport.diagnostics.provider}; candidate(s): ${preparedReport.candidateCount}`,
  );

  if (preparedReport.diagnostics.candidatesWithMissingPricing.length > 0) {
    logger.warn(
      `Missing pricing for candidate model(s): ${preparedReport.diagnostics.candidatesWithMissingPricing.join(', ')}`,
    );
  }

  if (preparedReport.diagnostics.warning) {
    logger.warn(preparedReport.diagnostics.warning);
  }

  if (preparedReport.format === 'terminal') {
    warnIfTerminalTableOverflows(preparedReport.output, (message) => {
      logger.warn(message);
    });
  }

  if (preparedReport.shareSvg) {
    const shareResult = await writeAndOpenShareSvgFile(
      'optimize-monthly-share.svg',
      preparedReport.shareSvg,
    );
    logger.info(`Wrote optimize share SVG: ${shareResult.outputPath}`);

    if (shareResult.opened) {
      logger.info(`Opened optimize share SVG: ${shareResult.outputPath}`);
    } else {
      logger.warn(
        `Could not open optimize share SVG: ${shareResult.outputPath} (${shareResult.openErrorMessage})`,
      );
    }
  }

  console.log(preparedReport.output);
}
