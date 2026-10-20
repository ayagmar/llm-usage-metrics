import { buildEventProjectLabels } from '../aggregate/project-key.js';
import {
  aggregateContextPressure,
  type AggregatedContextSource,
  type ContextModelRow,
  type ContextSessionRow,
} from '../context/context-pressure.js';
import { createModelPricingLookup } from '@ayagmar/agent-sessions/internal';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { resolveUsageDataRequest } from './build-usage-data.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import { limitRows, parseTopRowsOption, resolveTopRowLimit } from './top-option.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildUsageDataDeps,
  ContextCommandOptions,
  UsageDiagnostics,
} from './usage-data-contracts.js';

export type ContextDataResult = {
  grouping: 'model' | 'session';
  models: ContextModelRow[];
  /** With --by-session: the top sessions by peak prompt. */
  sessions: ContextSessionRow[];
  aggregatedSources: AggregatedContextSource[];
  /** Labels over every project in the report's events, not only the shown rows. */
  projectLabels: ReadonlyMap<string | undefined, string>;
  /** Set when no date flag was passed: the first day of the default window. */
  defaultWindowSince?: string;
  limitNote?: string;
  diagnostics: UsageDiagnostics;
};

export async function buildContextData(
  commandOptions: ContextCommandOptions,
  commandDeps: BuildUsageDataDeps = {},
): Promise<ContextDataResult> {
  const top = parseTopRowsOption(commandOptions.top);
  // Without date flags, the last 7 days, as `daily` reports them.
  const { options, deps, defaultWindowSince } = await resolveUsageDataRequest(
    'daily',
    commandOptions,
    commandDeps,
  );
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'context.dataset.total',
    () => buildUsageEventDataset(options, deps),
  );
  // The report needs tier rates and context limits, not event costs, so it loads prices
  // whenever an event names a model.
  const { pricingSource, pricingPolicy, pricingOrigin, pricingWarning } =
    await applyPricingToUsageEventDataset(dataset, deps, 'force');
  const report = measureRuntimeProfileStageSync(deps.runtimeProfile, 'context.aggregate', () =>
    aggregateContextPressure(dataset.filteredEvents, {
      lookupPricing: pricingSource
        ? createModelPricingLookup(pricingSource, pricingPolicy.costMode)
        : () => undefined,
      getContextLimit: (model) => pricingSource?.getMaxInputTokens?.(model),
    }),
  );
  const limited = commandOptions.bySession
    ? limitRows(report.sessions, resolveTopRowLimit(top), 'sessions', 'peak prompt')
    : { rows: [] };

  return {
    grouping: commandOptions.bySession ? 'session' : 'model',
    models: report.models,
    sessions: limited.rows,
    aggregatedSources: report.aggregatedSources,
    projectLabels: buildEventProjectLabels(dataset.filteredEvents),
    ...(defaultWindowSince ? { defaultWindowSince } : {}),
    ...(limited.limitNote ? { limitNote: limited.limitNote } : {}),
    diagnostics: buildUsageDiagnostics({
      adaptersToParse: dataset.adaptersToParse,
      successfulParseResults: dataset.successfulParseResults,
      sourceFailures: dataset.sourceFailures,
      pricingOrigin,
      pricingWarning,
      warnings: dataset.warnings,
      notes: dataset.notes,
      activeEnvOverrides: dataset.readEnvVarOverrides(),
      activeConfig: dataset.activeConfig,
      timezone: dataset.normalizedInputs.timezone,
      runtimeProfile: deps.runtimeProfile?.snapshot(),
    }),
  };
}
