import { getDefaultSourceIds } from '@ayagmar/agent-sessions/registry';

import { buildEventProjectLabels } from '../aggregate/project-key.js';
import { getCurrentLocalDateKey } from '../utils/time-buckets.js';
import {
  buildValueReport,
  resolvePlanScopes,
  type PlanScope,
  type ValueReportData,
} from '../value/build-value-report.js';
import { describeDefaultPlanFallback, selectPlans } from '../value/plans.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import { parseWindowFlags, resolvePeriodsSince } from './build-usage-data.js';
import {
  normalizeBuildUsageInputs,
  normalizeSourceFilter,
  validateSourceFilterValues,
} from './build-usage-data-inputs.js';
import type { AdapterParseResult } from './build-usage-data-parsing.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
  withPricingNotes,
} from './build-usage-event-dataset.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import { DEFAULT_PROJECT_ROWS, parseTopRowsOption, resolveTopRowLimit } from './top-option.js';
import type {
  BuildUsageDataDeps,
  UsageDiagnostics,
  ValueCommandOptions,
} from './usage-data-contracts.js';

export type ValueDataResult = {
  data: ValueReportData;
  diagnostics: UsageDiagnostics;
  /** Set when `--top` left projects out of a month. */
  limitNote?: string;
};

/**
 * `--last N` months, or the explicit dates; neither means full history. The window ends
 * today at the latest: months that have not happened yet would count a full plan price.
 */
function resolveWindowDates(
  options: ValueCommandOptions,
  today: string,
): { since?: string; until: string } {
  const lastMonths = parseWindowFlags(options, 'monthly');

  if (lastMonths !== undefined) {
    return { since: resolvePeriodsSince('monthly', today, lastMonths), until: today };
  }

  const until = options.until !== undefined && options.until < today ? options.until : today;

  if (options.since !== undefined && options.since > until) {
    throw new Error(`--since ${options.since} is after today (${today}); value has no months yet`);
  }

  return { since: options.since, until };
}

/**
 * A plan source without files, worded per plan. A source typed in --source is left out:
 * the dataset already warns about it. When no source has files, the "No session files
 * found" warning says so.
 */
function findPlanSourcesWithoutFiles(
  planScopes: readonly PlanScope[],
  parseResults: readonly AdapterParseResult[],
  typedSourceFilter: ReadonlySet<string> | undefined,
): string[] {
  if (!parseResults.some((result) => result.filesFound > 0)) {
    return [];
  }

  const sourcesWithoutFiles = new Set(
    parseResults
      .filter((result) => result.filesFound === 0)
      .map((result) => result.source.toLowerCase()),
  );

  return planScopes.flatMap(({ selected, sources }) =>
    sources
      .filter((source) => sourcesWithoutFiles.has(source) && !typedSourceFilter?.has(source))
      .map(
        (source) =>
          `plan ${selected.plan.id}: ${source} found no files; \`llm-usage doctor --source ${source}\` shows where it looks`,
      ),
  );
}

export async function buildValueData(
  commandOptions: ValueCommandOptions,
  commandDeps: BuildUsageDataDeps = {},
): Promise<ValueDataResult> {
  const projectLimit = resolveTopRowLimit(
    parseTopRowsOption(commandOptions.top),
    false,
    DEFAULT_PROJECT_ROWS,
  );
  const userConfigResolution = await resolveUserConfigForOptions(commandOptions, commandDeps);
  const { timezone, sourceFilter, sourceFilterLabel } = normalizeBuildUsageInputs(
    userConfigResolution.options,
    userConfigResolution.cliOptions,
  );
  // Before narrowing to the plans' sources, so a mistyped --source still fails.
  validateSourceFilterValues(sourceFilter, new Set(getDefaultSourceIds()), sourceFilterLabel);
  const plans = selectPlans(
    commandOptions.plan,
    commandOptions.planPrice,
    sourceFilter,
    sourceFilterLabel,
  );
  const planScopes = resolvePlanScopes(plans, sourceFilter, sourceFilterLabel);
  const planFallbackNote = describeDefaultPlanFallback(
    commandOptions.plan,
    plans,
    sourceFilterLabel,
  );
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
      projectLimit,
    }),
  );

  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    warnings: [
      ...dataset.warnings,
      ...findPlanSourcesWithoutFiles(
        planScopes,
        dataset.successfulParseResults,
        normalizeSourceFilter(userConfigResolution.cliOptions.source),
      ),
    ],
    notes: [
      ...(planFallbackNote === undefined ? [] : [planFallbackNote]),
      ...(options.cost === false
        ? dataset.notes
        : withPricingNotes(dataset.notes, pricedEvents, pricingResult)),
    ],
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  const limitNote = data.plans.some((plan) =>
    plan.months.some((month) => month.otherProjects !== null),
  )
    ? `Showing the top ${String(projectLimit)} projects of each month by cost. Use --top 0 for all.`
    : undefined;

  return { data, diagnostics, ...(limitNote ? { limitNote } : {}) };
}
