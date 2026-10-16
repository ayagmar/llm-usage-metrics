import {
  renderOptimizeReport,
  type OptimizeReportFormat,
} from '../render/render-optimize-report.js';
import { logger } from '../utils/logger.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { buildOptimizeData } from './build-optimize-data.js';
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
import type { OptimizeCommandOptions, OptimizeDiagnostics } from './usage-data-contracts.js';
import type { BuildOptimizeDataDeps } from './build-optimize-data.js';

const optimizeReportFormats = STANDARD_REPORT_FORMATS satisfies readonly OptimizeReportFormat[];

type OptimizePreparedDiagnostics = OptimizeDiagnostics & {
  candidateCount: number;
};

async function prepareOptimizeReport(
  granularity: ReportGranularity,
  options: OptimizeCommandOptions,
  deps: BuildOptimizeDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: optimizeReportFormats,
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
    buildShare: async (bundle, { runtimeProfile }) => {
      const window = toShareDateRange(options.since, options.until);

      return buildShareReportArtifact(
        {
          command: 'optimize',
          options,
          window,
          initialView: { ...window, granularity: toShareGranularity(granularity) },
          envelope: parseReportJsonEnvelope(
            renderOptimizeReport(bundle.optimizeData, 'json', { granularity }),
          ),
          fileBaseName: `optimize-${granularity}-share`,
          logLabel: 'optimize',
        },
        { ...deps, runtimeProfile },
      );
    },
    render: (bundle, format) =>
      renderOptimizeReport(bundle.optimizeData, format, {
        granularity,
        filtered: hasCliFilters(options),
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

  await runStandardPreparedReport({
    preparedReport,
    emitReportDiagnostics: emitOptimizeReportDiagnostics,
  });
}
