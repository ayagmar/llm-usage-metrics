import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { assembleUsageDataResult, buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildUsageDataDeps,
  ReportCommandOptions,
  UsageDataResult,
} from './usage-data-contracts.js';

export async function buildUsageData(
  granularity: ReportGranularity,
  options: ReportCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<UsageDataResult> {
  const dataset = await measureRuntimeProfileStage(deps.runtimeProfile, 'usage.dataset.total', () =>
    buildUsageEventDataset(options, deps),
  );
  const { pricedEvents, pricingOrigin, pricingWarning } = await applyPricingToUsageEventDataset(
    dataset,
    deps,
    'auto',
  );

  const rows = measureRuntimeProfileStageSync(deps.runtimeProfile, 'usage.aggregate', () =>
    aggregateUsage(pricedEvents, {
      granularity,
      timezone: dataset.normalizedInputs.timezone,
      sourceOrder: dataset.adaptersToParse.map((adapter) => adapter.id),
    }),
  );

  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  return assembleUsageDataResult(pricedEvents, rows, diagnostics);
}
