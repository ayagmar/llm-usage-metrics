import { createDefaultAdapters } from '@ayagmar/agent-sessions/registry';

import { getPricingFetcherRuntimeConfig } from '../config/runtime-overrides.js';
import { explainModelPricing, type PricingReportData } from '../pricing/explain-model-pricing.js';
import { renderPricingReport, type PricingReportFormat } from '../render/render-pricing-report.js';
import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';
import { logger } from '../utils/logger.js';
import { resolveUserConfigForOptions, type UserConfigResolutionDeps } from './apply-user-config.js';
import { normalizeBuildUsageInputs } from './build-usage-data-inputs.js';
import { getPerRequestSourceIds, resolvePricingSource } from './build-usage-data-pricing.js';
import {
  prepareReport,
  runPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import type { PricingCommandOptions, PricingLoadResult } from './usage-data-contracts.js';

const pricingReportFormats = STANDARD_REPORT_FORMATS satisfies readonly PricingReportFormat[];

export type BuildPricingDataDeps = UserConfigResolutionDeps & {
  /** Stands in for loading LiteLLM prices and the overrides file. */
  resolvePricingSource?: typeof resolvePricingSource;
};

type PricingDiagnostics = { pricingWarning?: string };

function validateModelNames(models: readonly string[]): void {
  if (models.some((model) => model.trim() === '')) {
    throw new Error('Model names must be non-empty');
  }
}

/**
 * Loads prices exactly as a report does (config `pricing.*` under the command-line flags)
 * and explains each name. It reads no usage and opens no event store.
 */
export async function buildPricingData(
  models: readonly string[],
  options: PricingCommandOptions,
  deps: BuildPricingDataDeps = {},
): Promise<{ data: PricingReportData; diagnostics: PricingDiagnostics }> {
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options;
  const { pricingUrl } = normalizeBuildUsageInputs(
    configuredOptions,
    userConfigResolution.cliOptions,
  );
  const loadPricingSource = deps.resolvePricingSource ?? resolvePricingSource;
  const pricing: PricingLoadResult = await loadPricingSource(
    { ...configuredOptions, pricingUrl },
    getPricingFetcherRuntimeConfig(userConfigResolution.loadedConfig.config),
  );

  return {
    data: {
      models: models.map((model) => explainModelPricing(pricing.source, model)),
      perRequestSources: [...getPerRequestSourceIds(createDefaultAdapters({}))].sort(
        compareByCodePoint,
      ),
    },
    diagnostics: { pricingWarning: pricing.warning },
  };
}

async function preparePricingReport(
  models: readonly string[],
  options: PricingCommandOptions,
  deps: BuildPricingDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: pricingReportFormats,
    validate: () => {
      validateModelNames(models);
    },
    buildData: () => buildPricingData(models, options, deps),
    getDiagnostics: (result) => result.diagnostics,
    render: (result, format) => renderPricingReport(result.data, format),
  });
}

export async function buildPricingReport(
  models: readonly string[],
  options: PricingCommandOptions,
  deps: BuildPricingDataDeps = {},
): Promise<string> {
  const preparedReport = await preparePricingReport(models, options, deps);
  return preparedReport.output;
}

export async function runPricingReport(
  models: string[],
  options: PricingCommandOptions,
): Promise<void> {
  const preparedReport = await preparePricingReport(models, options);

  await runPreparedReport({
    preparedReport,
    emitReportDiagnostics: (diagnostics) => {
      if (diagnostics.pricingWarning) {
        logger.warn(diagnostics.pricingWarning);
      }
    },
  });
}
