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
import { buildUsageData } from './build-usage-data.js';
import type { EfficiencyCommandOptions, EfficiencyDataResult } from './usage-data-contracts.js';

export type BuildEfficiencyDataDeps = {
  buildUsageData?: typeof buildUsageData;
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
  const buildUsage = deps.buildUsageData ?? buildUsageData;
  const collectOutcomes = deps.collectGitOutcomes ?? collectGitOutcomes;
  const resolveRepoRoot = deps.resolveRepoRoot ?? resolveRepoRootFromPathHint;
  const repoDir = options.repoDir?.trim();

  if (options.repoDir !== undefined && !repoDir) {
    throw new Error('--repo-dir must be a non-empty path');
  }

  const usageData = await buildUsage(granularity, options);
  const attribution = await attributeUsageEventsToRepo(
    usageData.events,
    repoDir ?? process.cwd(),
    resolveRepoRoot,
  );
  const matchedEventsWithSignal = attribution.matchedEvents.filter((event) =>
    hasMeaningfulEfficiencyUsageSignal(event),
  );
  const activeUsageDays = new Set(
    matchedEventsWithSignal.map((event) =>
      getPeriodKey(event.timestamp, 'daily', usageData.diagnostics.timezone),
    ),
  );
  const gitOutcomes = await collectOutcomes({
    repoDir,
    granularity,
    timezone: usageData.diagnostics.timezone,
    since: options.since,
    until: options.until,
    includeMergeCommits: options.includeMergeCommits,
    activeUsageDays,
  });
  const repoScopedUsageRows = aggregateUsage(matchedEventsWithSignal, {
    granularity,
    timezone: usageData.diagnostics.timezone,
    includeModelBreakdown: false,
  });

  const rows = aggregateEfficiency({
    usageRows: repoScopedUsageRows,
    periodOutcomes: gitOutcomes.periodOutcomes,
  });

  return {
    rows,
    diagnostics: {
      usage: usageData.diagnostics,
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
