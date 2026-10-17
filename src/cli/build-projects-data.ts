import {
  addTotals,
  aggregateUsage,
  createEmptyTotals,
  toRankedModelUsage,
} from '../aggregate/aggregate-usage.js';
import { buildEventProjectLabels, toProjectKey } from '../aggregate/project-key.js';
import type { UsageEvent } from '../domain/usage-event.js';
import type {
  PeriodProjectRow,
  ProjectUsageReportRow,
  UsageTotals,
} from '../domain/usage-report-row.js';
import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';
import { getPeriodKey, type ReportGranularity } from '../utils/time-buckets.js';
import { roundRatio } from '../value/build-value-report.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { resolveUsageDataRequest } from './build-usage-data.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
  withPricingNotes,
} from './build-usage-event-dataset.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildUsageDataDeps,
  ProjectsCommandOptions,
  UsageDiagnostics,
} from './usage-data-contracts.js';

const TOP_MODEL_COUNT = 3;

/** One project's usage over the whole window. */
export type ProjectRow = UsageTotals & {
  /** The project key, `null` for usage without a repository root. */
  repoRoot: string | null;
  project: string;
  /**
   * The project's part of the window's cost (0-1), rounded as value's `costShare`; null when
   * the window cost is not positive.
   */
  costShare: number | null;
  events: number;
  /** Distinct local dates (report timezone) with usage. */
  activeDays: number;
  /** The project's models with the most tokens, at most three. */
  topModels: string[];
};

export type ProjectsTotals = UsageTotals & {
  projects: number;
  events: number;
  activeDays: number;
};

export type ProjectsData = {
  /** Totals over every project in the window, also those `--top` leaves out. */
  totals: ProjectsTotals;
  /** Costliest first; with `--top`, only the top N. */
  projects: ProjectRow[];
  /** With `--granularity`: the shown projects' rows per period, each period's in label order. */
  granularity?: ReportGranularity;
  periods?: PeriodProjectRow[];
};

export type ProjectsDataResult = ProjectsData & {
  diagnostics: UsageDiagnostics;
  /** Set when `--top` left projects out. */
  limitNote?: string;
};

type ProjectActivity = { events: number; days: Set<string> };

type ProjectAccumulator = {
  repoRoot: string | null;
  project: string;
  totals: UsageTotals;
  modelTotals: Map<string, UsageTotals>;
};

function parseTopOption(top: string | undefined): number | undefined {
  if (top === undefined) {
    return undefined;
  }

  const normalized = top.trim();

  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new Error('--top must be a positive whole number');
  }

  return Number.parseInt(normalized, 10);
}

/** Events and active days per project key, plus the window's active days, in one pass. */
function collectProjectActivity(
  events: readonly UsageEvent[],
  timezone: string,
): { byProject: Map<string | undefined, ProjectActivity>; activeDays: number } {
  const byProject = new Map<string | undefined, ProjectActivity>();
  const allDays = new Set<string>();

  for (const event of events) {
    const key = toProjectKey(event.repoRoot);
    const dateKey = getPeriodKey(event.timestamp, 'daily', timezone);
    let activity = byProject.get(key);

    if (!activity) {
      activity = { events: 0, days: new Set<string>() };
      byProject.set(key, activity);
    }

    activity.events += 1;
    activity.days.add(dateKey);
    allDays.add(dateKey);
  }

  return { byProject, activeDays: allDays.size };
}

/** Sums each project's period rows into one accumulator per project. */
function mergeProjectRows(rows: readonly ProjectUsageReportRow[]): ProjectAccumulator[] {
  const byKey = new Map<string | null, ProjectAccumulator>();

  for (const row of rows) {
    if (row.rowType !== 'period_project') {
      continue;
    }

    let accumulator = byKey.get(row.repoRoot);

    if (!accumulator) {
      accumulator = {
        repoRoot: row.repoRoot,
        project: row.project,
        totals: createEmptyTotals(),
        modelTotals: new Map(),
      };
      byKey.set(row.repoRoot, accumulator);
    }

    addTotals(accumulator.totals, row);

    for (const modelUsage of row.modelBreakdown) {
      const modelTotals = accumulator.modelTotals.get(modelUsage.model) ?? createEmptyTotals();
      addTotals(modelTotals, modelUsage);
      accumulator.modelTotals.set(modelUsage.model, modelTotals);
    }
  }

  return [...byKey.values()];
}

/** Costliest first, then most tokens, then by label. */
function compareProjectRows(left: ProjectRow, right: ProjectRow): number {
  return (
    (right.costUsd ?? 0) - (left.costUsd ?? 0) ||
    right.totalTokens - left.totalTokens ||
    compareByCodePoint(left.project, right.project)
  );
}

function toProjectRow(
  accumulator: ProjectAccumulator,
  activity: ProjectActivity | undefined,
  windowCostUsd: number | undefined,
): ProjectRow {
  const { costUsd } = accumulator.totals;

  return {
    repoRoot: accumulator.repoRoot,
    project: accumulator.project,
    ...accumulator.totals,
    costShare:
      windowCostUsd !== undefined && windowCostUsd > 0 && costUsd !== undefined
        ? roundRatio(costUsd / windowCostUsd)
        : null,
    events: activity?.events ?? 0,
    activeDays: activity?.days.size ?? 0,
    topModels: toRankedModelUsage(accumulator.modelTotals).models.slice(0, TOP_MODEL_COUNT),
  };
}

/**
 * Per-project totals over priced, filtered events. Labels come from one
 * `buildEventProjectLabels` call over those events.
 */
export function aggregateProjects(
  events: UsageEvent[],
  options: { timezone: string; granularity?: ReportGranularity; top?: number },
): ProjectsData {
  const rows = aggregateUsage(events, {
    granularity: options.granularity ?? 'monthly',
    timezone: options.timezone,
    primary: 'repo',
    projectLabels: buildEventProjectLabels(events),
  });
  const grandTotal = rows[rows.length - 1];
  const activity = collectProjectActivity(events, options.timezone);
  const allProjects = mergeProjectRows(rows)
    .map((accumulator) =>
      toProjectRow(
        accumulator,
        activity.byProject.get(accumulator.repoRoot ?? undefined),
        grandTotal.costUsd,
      ),
    )
    .sort(compareProjectRows);
  const projects = options.top === undefined ? allProjects : allProjects.slice(0, options.top);
  const windowTotals = createEmptyTotals();
  addTotals(windowTotals, grandTotal);
  const totals: ProjectsTotals = {
    ...windowTotals,
    projects: allProjects.length,
    events: events.length,
    activeDays: activity.activeDays,
  };

  if (options.granularity === undefined) {
    return { totals, projects };
  }

  const shownKeys = new Set(projects.map((project) => project.repoRoot));

  return {
    totals,
    projects,
    granularity: options.granularity,
    periods: rows.filter(
      (row): row is PeriodProjectRow =>
        row.rowType === 'period_project' && shownKeys.has(row.repoRoot),
    ),
  };
}

export async function buildProjectsData(
  commandOptions: ProjectsCommandOptions,
  commandDeps: BuildUsageDataDeps = {},
): Promise<ProjectsDataResult> {
  const top = parseTopOption(commandOptions.top);
  // Monthly has no default window: full history unless --last N months or dates narrow it.
  const { options, deps } = await resolveUsageDataRequest('monthly', commandOptions, commandDeps);
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'projects.dataset.total',
    () => buildUsageEventDataset(options, deps),
  );
  const pricingResult = await applyPricingToUsageEventDataset(dataset, deps, 'auto');
  const { pricedEvents, pricingOrigin, pricingWarning } = pricingResult;
  const data = measureRuntimeProfileStageSync(deps.runtimeProfile, 'projects.aggregate', () =>
    aggregateProjects(pricedEvents, {
      timezone: dataset.normalizedInputs.timezone,
      granularity: commandOptions.granularity,
      top,
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
      commandOptions.cost === false
        ? dataset.notes
        : withPricingNotes(dataset.notes, pricedEvents, pricingResult),
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });
  const limitNote =
    data.projects.length < data.totals.projects
      ? `Showing the top ${String(data.projects.length)} of ${String(data.totals.projects)} projects by cost over the whole window.`
      : undefined;

  return { ...data, diagnostics, ...(limitNote ? { limitNote } : {}) };
}
