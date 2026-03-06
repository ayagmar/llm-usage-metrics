import {
  renderOptimizeReport,
  type OptimizeReportFormat,
} from '../render/render-optimize-report.js';
import { renderOptimizeMonthlyShareSvg } from '../render/render-optimize-share-svg.js';
import { logger } from '../utils/logger.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { buildOptimizeData } from './build-optimize-data.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { prepareReport, runPreparedReport } from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { OptimizeCommandOptions, OptimizeDiagnostics } from './usage-data-contracts.js';

const optimizeReportFormats = [
  'terminal',
  'markdown',
  'json',
] as const satisfies readonly OptimizeReportFormat[];

type OptimizePreparedDiagnostics = OptimizeDiagnostics & {
  candidateCount: number;
};

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
  deps: Parameters<typeof buildOptimizeData>[2] = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: optimizeReportFormats,
    validate: () => {
      validateShareOption(granularity, options);
    },
    buildData: async () => {
      const optimizeData = await buildOptimizeData(granularity, options, deps);

      return {
        optimizeData,
        candidateCount: optimizeData.rows.filter(
          (row) => row.rowType === 'candidate' && row.periodKey === 'ALL',
        ).length,
      };
    },
    getDiagnostics: (bundle): OptimizePreparedDiagnostics => ({
      ...bundle.optimizeData.diagnostics,
      candidateCount: bundle.candidateCount,
    }),
    runtimeProfile: deps.runtimeProfile,
    createShareArtifact: options.share
      ? (bundle) => ({
          fileName: 'optimize-monthly-share.svg',
          svg: renderOptimizeMonthlyShareSvg(bundle.optimizeData),
          logLabel: 'optimize',
        })
      : undefined,
    render: (bundle, format) =>
      renderOptimizeReport(bundle.optimizeData, format, {
        granularity,
      }),
  });
}

function emitOptimizeReportDiagnostics(diagnostics: OptimizePreparedDiagnostics): void {
  logger.info(
    `Optimize provider scope: ${diagnostics.provider}; candidate(s): ${diagnostics.candidateCount}`,
  );

  if (diagnostics.candidatesWithMissingPricing.length > 0) {
    logger.warn(
      `Missing pricing for candidate model(s): ${diagnostics.candidatesWithMissingPricing.join(', ')}`,
    );
  }

  if (diagnostics.warning) {
    logger.warn(diagnostics.warning);
  }
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
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareOptimizeReport(granularity, options, { runtimeProfile });

  await runPreparedReport<OptimizePreparedDiagnostics, OptimizeReportFormat>({
    preparedReport,
    emitCommonDiagnostics: (diagnostics) => {
      emitDiagnostics(diagnostics.usage);
    },
    getEnvVarOverrides: (diagnostics) => diagnostics.usage.activeEnvOverrides,
    emitReportDiagnostics: emitOptimizeReportDiagnostics,
    getRuntimeProfile: (diagnostics) => diagnostics.usage.runtimeProfile,
    warnOnTerminalOverflow: true,
  });
}
