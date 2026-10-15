import { getDefaultSourceIds } from '@ayagmar/agent-sessions/registry';

import { buildEventProjectLabels } from '../aggregate/project-key.js';
import { getCurrentLocalDateKey } from '../utils/time-buckets.js';
import {
  buildValueReport,
  resolvePlanScopes,
  type ValueReportData,
} from '../value/build-value-report.js';
import { selectPlans } from '../value/plans.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import { parseLastOption, resolvePeriodsSince } from './build-usage-data.js';
import {
  normalizeBuildUsageInputs,
  validateSourceFilterValues,
} from './build-usage-data-inputs.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
  withPricingNotes,
} from './build-usage-event-dataset.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildUsageDataDeps,
  UsageDiagnostics,
  ValueCommandOptions,
} from './usage-data-contracts.js';

export type ValueDataResult = {
  data: ValueReportData;
  diagnostics: UsageDiagnostics;
};

/** `--last N` months, or the explicit dates; neither means full history. */
function resolveWindowDates(
  options: ValueCommandOptions,
  today: string,
): { since?: string; until?: string } {
  const hasDates = options.since !== undefined || options.until !== undefined;
  const lastMonths = parseLastOption(options.last);

  if (lastMonths !== undefined && (hasDates || options.all)) {
    throw new Error('--last cannot be combined with --since, --until, or --all');
  }

  if (options.all && hasDates) {
    throw new Error('--all cannot be combined with --since or --until');
  }

  if (lastMonths !== undefined) {
    return { since: resolvePeriodsSince('monthly', today, lastMonths), until: today };
  }

  return { since: options.since, until: options.until };
}

export async function buildValueData(
  commandOptions: ValueCommandOptions,
  commandDeps: BuildUsageDataDeps = {},
): Promise<ValueDataResult> {
  const plans = selectPlans(commandOptions.plan, commandOptions.planPrice);
  const userConfigResolution = await resolveUserConfigForOptions(commandOptions, commandDeps);
  const { timezone, sourceFilter, sourceFilterLabel } = normalizeBuildUsageInputs(
    userConfigResolution.options,
    userConfigResolution.cliOptions,
  );
  // Before narrowing to the plans' sources, so a mistyped --source still fails.
  validateSourceFilterValues(sourceFilter, new Set(getDefaultSourceIds()), sourceFilterLabel);
  const planScopes = resolvePlanScopes(plans, sourceFilter, sourceFilterLabel);
  const today = getCurrentLocalDateKey(timezone, commandDeps.now?.() ?? new Date());
  const window = resolveWindowDates(userConfigResolution.options, today);
  const options = {
    ...userConfigResolution.options,
    source: [...new Set(planScopes.flatMap((scope) => scope.sources))],
    since: window.since,
    until: window.until,
  };
  const deps = {
    ...commandDeps,
    userConfigResolution: { ...userConfigResolution, options },
  };

  const dataset = await measureRuntimeProfileStage(deps.runtimeProfile, 'value.dataset.total', () =>
    buildUsageEventDataset(options, deps),
  );
  const pricingResult = await applyPricingToUsageEventDataset(dataset, deps, 'auto');
  const { pricedEvents, pricingOrigin, pricingWarning } = pricingResult;

  const data = measureRuntimeProfileStageSync(deps.runtimeProfile, 'value.aggregate', () =>
    buildValueReport(pricedEvents, {
      plans: planScopes,
      timezone: dataset.normalizedInputs.timezone,
      today,
      since: window.since,
      until: window.until,
      projectLabels: buildEventProjectLabels(pricedEvents),
    }),
  );

  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    warnings: dataset.warnings,
    notes:
      options.cost === false
        ? dataset.notes
        : withPricingNotes(dataset.notes, pricedEvents, pricingResult),
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  return { data, diagnostics };
}
