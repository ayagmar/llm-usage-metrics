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

      return { optimizeData };
    },
    getDiagnostics: (bundle) => bundle.optimizeData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    buildShare: async (bundle, { runtimeProfile }) => {
      const window = toShareDateRange(options.since, options.until);
      const { inferredProvider } = bundle.optimizeData.diagnostics;

      return buildShareReportArtifact(
        {
          command: 'optimize',
          // The usage views cover the provider the candidates panel prices.
          options: inferredProvider ? { ...options, provider: inferredProvider } : options,
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

function emitOptimizeReportDiagnostics(diagnostics: OptimizeDiagnostics): void {
  if (diagnostics.inferredProvider) {
    logger.info(
      `Scoped to ${diagnostics.inferredProvider}, the provider of the candidate models; other providers' usage is not compared. Pass --provider to choose.`,
    );
  }

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
