import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import { aggregateEfficiency } from '../efficiency/aggregate-efficiency.js';
import { collectGitOutcomes } from '../efficiency/git-outcome-collector.js';
import {
  attributeUsageEventsToRepo,
  resolveRepoRootFromPathHint,
  type RepoRootResolver,
} from '../efficiency/repo-attribution.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { getPeriodKey, type ReportGranularity } from '../utils/time-buckets.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import type {
  BuildUsageDataDeps,
  EfficiencyCommandOptions,
  EfficiencyDataResult,
} from './usage-data-contracts.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';

export type BuildEfficiencyDataDeps = BuildUsageDataDeps & {
  buildUsageEventDataset?: typeof buildUsageEventDataset;
  applyPricingToUsageEventDataset?: typeof applyPricingToUsageEventDataset;
  collectGitOutcomes?: typeof collectGitOutcomes;
  resolveRepoRoot?: RepoRootResolver;
};

function hasActiveRepeatedFilter(value: string | string[] | undefined): boolean {
  if (!value) {
    return false;
  }

  const values = Array.isArray(value) ? value : [value];

  return values.some((entry) =>
    entry
      .split(',')
      .map((candidate) => candidate.trim())
      .some((candidate) => candidate.length > 0),
  );
}

function hasActiveProviderFilter(provider: string | undefined): boolean {
  return Boolean(provider?.trim());
}

function hasActiveTextOption(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function resolveScopeNote(options: EfficiencyCommandOptions): string | undefined {
  const activeFilters: string[] = [];

  if (hasActiveTextOption(options.piDir)) {
    activeFilters.push('--pi-dir');
  }

  if (hasActiveTextOption(options.codexDir)) {
    activeFilters.push('--codex-dir');
  }

  if (hasActiveTextOption(options.geminiDir)) {
    activeFilters.push('--gemini-dir');
  }

  if (hasActiveTextOption(options.droidDir)) {
    activeFilters.push('--droid-dir');
  }

  if (hasActiveTextOption(options.opencodeDb)) {
    activeFilters.push('--opencode-db');
  }

  if (hasActiveRepeatedFilter(options.sourceDir)) {
    activeFilters.push('--source-dir');
  }

  if (hasActiveRepeatedFilter(options.source)) {
    activeFilters.push('--source');
  }

  if (hasActiveProviderFilter(options.provider)) {
    activeFilters.push('--provider');
  }

  if (hasActiveRepeatedFilter(options.model)) {
    activeFilters.push('--model');
  }

  if (activeFilters.length === 0) {
    return undefined;
  }

  return `Usage filters (${activeFilters.join(', ')}) affect commit attribution too: only commit days with matching repo-attributed usage events are counted.`;
}

function hasMeaningfulEfficiencyUsageSignal(event: UsageEvent): boolean {
  return event.totalTokens > 0 || (event.costUsd !== undefined && event.costUsd > 0);
}

export async function buildEfficiencyData(
  granularity: ReportGranularity,
  options: EfficiencyCommandOptions,
  deps: BuildEfficiencyDataDeps = {},
): Promise<EfficiencyDataResult> {
  const buildDataset = deps.buildUsageEventDataset ?? buildUsageEventDataset;
  const applyPricing = deps.applyPricingToUsageEventDataset ?? applyPricingToUsageEventDataset;
  const collectOutcomes = deps.collectGitOutcomes ?? collectGitOutcomes;
  const resolveRepoRoot = deps.resolveRepoRoot ?? resolveRepoRootFromPathHint;
  const repoDir = options.repoDir?.trim();

  if (options.repoDir !== undefined && !repoDir) {
    throw new Error('--repo-dir must be a non-empty path');
  }

  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'efficiency.dataset.total',
    () => buildDataset(options, deps),
  );
  const { pricedEvents, pricingOrigin, pricingWarning } = await applyPricing(dataset, deps, 'auto');
  const attribution = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'efficiency.attribute_repo',
    () => attributeUsageEventsToRepo(pricedEvents, repoDir ?? process.cwd(), resolveRepoRoot),
  );
  const matchedEventsWithSignal = attribution.matchedEvents.filter((event) =>
    hasMeaningfulEfficiencyUsageSignal(event),
  );
  const activeUsageDays = new Set(
    matchedEventsWithSignal.map((event) =>
      getPeriodKey(event.timestamp, 'daily', dataset.normalizedInputs.timezone),
    ),
  );
  const gitOutcomes = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'efficiency.collect_git_outcomes',
    () =>
      collectOutcomes({
        repoDir,
        granularity,
        timezone: dataset.normalizedInputs.timezone,
        since: options.since,
        until: options.until,
        includeMergeCommits: options.includeMergeCommits,
        activeUsageDays,
      }),
  );
  const repoScopedUsageRows = measureRuntimeProfileStageSync(
    deps.runtimeProfile,
    'efficiency.aggregate_usage',
    () =>
      aggregateUsage(matchedEventsWithSignal, {
        granularity,
        timezone: dataset.normalizedInputs.timezone,
        includeModelBreakdown: false,
      }),
  );

  const rows = measureRuntimeProfileStageSync(deps.runtimeProfile, 'efficiency.aggregate', () =>
    aggregateEfficiency({
      usageRows: repoScopedUsageRows,
      periodOutcomes: gitOutcomes.periodOutcomes,
    }),
  );
  const usageDiagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  return {
    rows,
    diagnostics: {
      usage: usageDiagnostics,
      repoDir: gitOutcomes.diagnostics.repoDir,
      includeMergeCommits: gitOutcomes.diagnostics.includeMergeCommits,
      gitCommitCount: gitOutcomes.diagnostics.commitsCollected,
      gitLinesAdded: gitOutcomes.diagnostics.linesAdded,
      gitLinesDeleted: gitOutcomes.diagnostics.linesDeleted,
      repoMatchedUsageEvents: attribution.matchedEventCount,
      repoExcludedUsageEvents: attribution.excludedEventCount,
      repoUnattributedUsageEvents: attribution.unattributedEventCount,
      scopeNote: resolveScopeNote(options),
    },
  };
}
