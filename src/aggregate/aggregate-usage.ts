import { LOCAL_MACHINE_NAME, type UsageEvent } from '../domain/usage-event.js';
import type {
  GrandTotalRow,
  ModelUsageBreakdown,
  PeriodCombinedRow,
  PeriodProjectRow,
  PeriodSourceRow,
  ProjectUsageReportRow,
  UsageReportRow,
  UsageTotals,
} from '../domain/usage-report-row.js';
import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';
import { getPeriodKey, type UsageGranularity } from '../utils/time-buckets.js';
import { addUsd } from '../utils/usd-math.js';
import { formatInteger } from '../render/format-number.js';
import { toProjectKey } from './project-key.js';

export type AggregateUsageOptions = {
  granularity: UsageGranularity;
  timezone: string;
  sourceOrder?: string[];
  includeModelBreakdown?: boolean;
  /** Splits each source row per machine (`--by-machine`), per project (`--by-repo`), or both. */
  split?: { machine?: boolean; repo?: boolean };
  /**
   * `repo`: one `period_project` row per project instead of one row per source; `split`
   * does not apply.
   */
  primary?: 'source' | 'repo';
  /**
   * Labels from one `buildProjectLabels` call over the report's filtered events; required
   * with `split.repo` or `primary: 'repo'`.
   */
  projectLabels?: ReadonlyMap<string | undefined, string>;
  /**
   * With `split.repo`: each period keeps its `count` projects ranked first and folds the
   * others into one row per source (and machine).
   */
  projectLimit?: ProjectLimit;
};

/**
 * Projects per period by cost (then tokens), or by tokens alone when cost is hidden. A period
 * where a project's cost is incomplete is ranked by tokens, so an unpriced project is not
 * folded as if it cost nothing.
 */
export type ProjectLimit = { count: number; rankedBy: 'cost' | 'tokens' };

/** What a row groups by, taken from its first event. */
type RowGroup = {
  source: string;
  machine?: string;
  /** Present when the row is per project; `key` is undefined for unattributed usage. */
  project?: { key: string | undefined; label: string };
  /** Set on the row that folds the projects past `projectLimit`: how many it holds. */
  otherProjects?: number;
};

type RowAccumulator = {
  group: RowGroup;
  totals: UsageTotals;
  modelTotals?: Map<string, UsageTotals>;
};

type RankedModelUsage = {
  models: string[];
  modelBreakdown: ModelUsageBreakdown[];
};

export function createEmptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

function createRowAccumulator(group: RowGroup, includeModelBreakdown: boolean): RowAccumulator {
  return {
    group,
    totals: createEmptyTotals(),
    modelTotals: includeModelBreakdown ? new Map<string, UsageTotals>() : undefined,
  };
}

export function addEventToTotals(target: UsageTotals, event: UsageEvent): void {
  target.inputTokens += event.inputTokens;
  target.outputTokens += event.outputTokens;
  target.reasoningTokens += event.reasoningTokens;
  target.cacheReadTokens += event.cacheReadTokens;
  target.cacheWriteTokens += event.cacheWriteTokens;
  target.totalTokens += event.totalTokens;

  if (event.costUsd === undefined) {
    target.costIncomplete = true;
    return;
  }

  target.costUsd = addUsd(target.costUsd ?? 0, event.costUsd);
}

export function normalizeModelKey(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }

  const normalized = model.trim().toLowerCase();
  return normalized || undefined;
}

function addEventToAccumulator(
  accumulator: RowAccumulator,
  event: UsageEvent,
  includeModelBreakdown: boolean,
): void {
  addEventToTotals(accumulator.totals, event);

  if (!includeModelBreakdown) {
    return;
  }

  if (!accumulator.modelTotals) {
    return;
  }

  const normalizedModel = normalizeModelKey(event.model);

  if (!normalizedModel) {
    return;
  }

  let modelTotals = accumulator.modelTotals.get(normalizedModel);

  if (!modelTotals) {
    modelTotals = createEmptyTotals();
    accumulator.modelTotals.set(normalizedModel, modelTotals);
  }

  addEventToTotals(modelTotals, event);
}

export function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.totalTokens += source.totalTokens;

  if (source.costUsd !== undefined) {
    target.costUsd = addUsd(target.costUsd ?? 0, source.costUsd);
  }

  if (source.costIncomplete) {
    target.costIncomplete = true;
  }
}

function mergeModelTotals(
  targetModelTotals: Map<string, UsageTotals>,
  sourceModelTotals: ReadonlyMap<string, UsageTotals>,
): void {
  for (const [model, sourceTotals] of sourceModelTotals) {
    const targetTotals = targetModelTotals.get(model) ?? createEmptyTotals();
    addTotals(targetTotals, sourceTotals);
    targetModelTotals.set(model, targetTotals);
  }
}

function compareModelUsageBreakdown(left: ModelUsageBreakdown, right: ModelUsageBreakdown): number {
  if (left.totalTokens !== right.totalTokens) {
    return right.totalTokens - left.totalTokens;
  }

  const leftCost = left.costUsd ?? Number.NEGATIVE_INFINITY;
  const rightCost = right.costUsd ?? Number.NEGATIVE_INFINITY;

  if (leftCost !== rightCost) {
    return rightCost - leftCost;
  }

  if (left.inputTokens !== right.inputTokens) {
    return right.inputTokens - left.inputTokens;
  }

  return compareByCodePoint(left.model, right.model);
}

export function toRankedModelUsage(
  modelTotals: ReadonlyMap<string, UsageTotals>,
): RankedModelUsage {
  const modelBreakdown = [...modelTotals.entries()]
    .map(([model, totals]) => ({
      model,
      ...totals,
    }))
    .sort(compareModelUsageBreakdown);

  return {
    models: modelBreakdown.map((modelUsage) => modelUsage.model),
    modelBreakdown,
  };
}

/** Orders source ids as `sourceOrder` lists them, then unlisted ones by code point. */
export function createSourceComparator(
  sourceOrder: readonly string[],
): (left: string, right: string) => number {
  const sourceWeightMap = new Map(sourceOrder.map((source, index) => [source, index]));

  return (left, right) => {
    const leftWeight = sourceWeightMap.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightWeight = sourceWeightMap.get(right) ?? Number.MAX_SAFE_INTEGER;

    if (leftWeight !== rightWeight) {
      return leftWeight - rightWeight;
    }

    return compareByCodePoint(left, right);
  };
}

type RowSplit = { machine: boolean; repo: boolean; primaryRepo: boolean };

/** A row key that is unique per row group; `\0` cannot occur in ids or paths. */
function toSplitRowKey(event: UsageEvent, split: RowSplit): string {
  const projectToken = split.repo ? (toProjectKey(event.repoRoot) ?? '\0') : '';

  if (split.primaryRepo) {
    return projectToken;
  }

  const machineToken = split.machine ? (event.machine ?? LOCAL_MACHINE_NAME) : '';
  return `${event.source}\0${machineToken}\0${projectToken}`;
}

function toRowGroup(
  event: UsageEvent,
  split: RowSplit,
  projectLabels: ReadonlyMap<string | undefined, string> | undefined,
): RowGroup {
  const group: RowGroup = { source: event.source };

  if (split.machine) {
    group.machine = event.machine ?? LOCAL_MACHINE_NAME;
  }

  if (split.repo) {
    const key = toProjectKey(event.repoRoot);
    const label = projectLabels?.get(key);

    if (label === undefined) {
      throw new Error(`No project label for ${key ?? 'unattributed usage'}`);
    }

    group.project = { key, label };
  }

  return group;
}

/** Projects by label, unattributed usage next to last, the folded other projects last. */
function compareProjects(left: RowGroup, right: RowGroup): number {
  if (!left.project || !right.project) {
    return 0;
  }

  return (
    Number(left.otherProjects !== undefined) - Number(right.otherProjects !== undefined) ||
    Number(left.project.key === undefined) - Number(right.project.key === undefined) ||
    compareByCodePoint(left.project.label, right.project.label)
  );
}

function compareRankedTotals(
  left: UsageTotals,
  right: UsageTotals,
  rankedBy: ProjectLimit['rankedBy'],
): number {
  return (
    (rankedBy === 'cost' ? (right.costUsd ?? 0) - (left.costUsd ?? 0) : 0) ||
    right.totalTokens - left.totalTokens
  );
}

/** A period's rows with the projects past `limit` folded into one row per source and machine. */
function foldOtherProjects(
  accumulators: RowAccumulator[],
  limit: ProjectLimit,
  includeModelBreakdown: boolean,
): RowAccumulator[] {
  const projects = new Map<string | undefined, { label: string; totals: UsageTotals }>();

  for (const { group, totals } of accumulators) {
    if (!group.project) {
      return accumulators;
    }

    let project = projects.get(group.project.key);

    if (!project) {
      project = { label: group.project.label, totals: createEmptyTotals() };
      projects.set(group.project.key, project);
    }

    addTotals(project.totals, totals);
  }

  // Folding a single project would hide its name without saving a row.
  if (projects.size <= limit.count + 1) {
    return accumulators;
  }

  const rankedBy = [...projects.values()].some(({ totals }) => totals.costIncomplete)
    ? 'tokens'
    : limit.rankedBy;
  const keptKeys = new Set(
    [...projects]
      .sort(
        ([, left], [, right]) =>
          compareRankedTotals(left.totals, right.totals, rankedBy) ||
          compareByCodePoint(left.label, right.label),
      )
      .slice(0, limit.count)
      .map(([key]) => key),
  );
  const kept: RowAccumulator[] = [];
  const others = new Map<
    string,
    { accumulator: RowAccumulator; projectKeys: Set<string | undefined> }
  >();

  for (const accumulator of accumulators) {
    const { group } = accumulator;

    if (keptKeys.has(group.project?.key)) {
      kept.push(accumulator);
      continue;
    }

    const otherKey = `${group.source}\0${group.machine ?? ''}`;
    let other = others.get(otherKey);

    if (!other) {
      other = {
        accumulator: createRowAccumulator(
          {
            source: group.source,
            ...(group.machine === undefined ? {} : { machine: group.machine }),
          },
          includeModelBreakdown,
        ),
        projectKeys: new Set(),
      };
      others.set(otherKey, other);
    }

    other.projectKeys.add(group.project?.key);
    addTotals(other.accumulator.totals, accumulator.totals);

    if (other.accumulator.modelTotals && accumulator.modelTotals) {
      mergeModelTotals(other.accumulator.modelTotals, accumulator.modelTotals);
    }
  }

  for (const { accumulator, projectKeys } of others.values()) {
    const count = projectKeys.size;
    accumulator.group.project = {
      key: undefined,
      label: `${formatInteger(count)} other ${count === 1 ? 'project' : 'projects'}`,
    };
    accumulator.group.otherProjects = count;
    kept.push(accumulator);
  }

  return kept;
}

/** Sources in their usual order; with --by-machine, this machine before the others. */
function compareRowGroups(
  left: RowGroup,
  right: RowGroup,
  compareSources: (left: string, right: string) => number,
  split: RowSplit,
): number {
  if (split.primaryRepo) {
    return compareProjects(left, right);
  }

  return (
    compareSources(left.source, right.source) ||
    Number(left.machine !== undefined && left.machine !== LOCAL_MACHINE_NAME) -
      Number(right.machine !== undefined && right.machine !== LOCAL_MACHINE_NAME) ||
    compareByCodePoint(left.machine ?? '', right.machine ?? '') ||
    compareProjects(left, right)
  );
}

function toGroupRow(
  periodKey: string,
  group: RowGroup,
  rankedModelUsage: RankedModelUsage,
  totals: UsageTotals,
  primaryRepo: boolean,
): PeriodSourceRow | PeriodProjectRow {
  if (primaryRepo && group.project) {
    return {
      rowType: 'period_project',
      periodKey,
      repoRoot: group.project.key ?? null,
      project: group.project.label,
      models: rankedModelUsage.models,
      modelBreakdown: rankedModelUsage.modelBreakdown,
      ...totals,
    };
  }

  return {
    rowType: 'period_source',
    periodKey,
    source: group.source,
    ...(group.machine === undefined ? {} : { machine: group.machine }),
    ...(group.project === undefined
      ? {}
      : group.otherProjects === undefined
        ? { repoRoot: group.project.key ?? null, project: group.project.label }
        : { project: group.project.label, otherProjects: group.otherProjects }),
    models: rankedModelUsage.models,
    modelBreakdown: rankedModelUsage.modelBreakdown,
    ...totals,
  };
}

export function aggregateUsage(
  events: UsageEvent[],
  options: AggregateUsageOptions & { primary: 'repo' },
): ProjectUsageReportRow[];
export function aggregateUsage(
  events: UsageEvent[],
  options: AggregateUsageOptions & { primary?: 'source' },
): UsageReportRow[];
export function aggregateUsage(
  events: UsageEvent[],
  options: AggregateUsageOptions,
): (UsageReportRow | ProjectUsageReportRow)[] {
  const primaryRepo = options.primary === 'repo';
  const split: RowSplit = {
    machine: !primaryRepo && options.split?.machine === true,
    repo: primaryRepo || options.split?.repo === true,
    primaryRepo,
  };
  // Without a split the row key is the source itself, so the common path builds no key.
  const isSplit = split.machine || split.repo;
  const includeModelBreakdown = options.includeModelBreakdown ?? true;
  const compareSources = createSourceComparator(options.sourceOrder ?? []);

  const periodMap = new Map<string, Map<string, RowAccumulator>>();

  for (const event of events) {
    const periodKey = getPeriodKey(event.timestamp, options.granularity, options.timezone);
    let periodSources = periodMap.get(periodKey);

    if (!periodSources) {
      periodSources = new Map<string, RowAccumulator>();
      periodMap.set(periodKey, periodSources);
    }

    const rowKey = isSplit ? toSplitRowKey(event, split) : event.source;
    let rowAccumulator = periodSources.get(rowKey);

    if (!rowAccumulator) {
      rowAccumulator = createRowAccumulator(
        isSplit ? toRowGroup(event, split, options.projectLabels) : { source: event.source },
        includeModelBreakdown,
      );
      periodSources.set(rowKey, rowAccumulator);
    }

    addEventToAccumulator(rowAccumulator, event, includeModelBreakdown);
  }

  const sortedPeriodKeys = [...periodMap.keys()].sort(compareByCodePoint);
  const rows: (UsageReportRow | ProjectUsageReportRow)[] = [];
  const grandTotals = createEmptyTotals();
  const grandModelTotals = new Map<string, UsageTotals>();

  for (const periodKey of sortedPeriodKeys) {
    const sourceMap = periodMap.get(periodKey);

    if (!sourceMap) {
      continue;
    }

    const periodCombinedTotals = createEmptyTotals();
    const periodCombinedModelTotals = new Map<string, UsageTotals>();

    const periodAccumulators =
      split.repo && !primaryRepo && options.projectLimit !== undefined
        ? foldOtherProjects([...sourceMap.values()], options.projectLimit, includeModelBreakdown)
        : [...sourceMap.values()];
    const sortedAccumulators = periodAccumulators.sort((left, right) =>
      compareRowGroups(left.group, right.group, compareSources, split),
    );

    for (const accumulator of sortedAccumulators) {
      const rankedModelUsage =
        includeModelBreakdown && accumulator.modelTotals
          ? toRankedModelUsage(accumulator.modelTotals)
          : { models: [], modelBreakdown: [] };

      rows.push(
        toGroupRow(periodKey, accumulator.group, rankedModelUsage, accumulator.totals, primaryRepo),
      );

      addTotals(periodCombinedTotals, accumulator.totals);
      addTotals(grandTotals, accumulator.totals);
      if (includeModelBreakdown && accumulator.modelTotals) {
        mergeModelTotals(periodCombinedModelTotals, accumulator.modelTotals);
        mergeModelTotals(grandModelTotals, accumulator.modelTotals);
      }
    }

    if (sortedAccumulators.length > 1) {
      const rankedCombinedModels = includeModelBreakdown
        ? toRankedModelUsage(periodCombinedModelTotals)
        : { models: [], modelBreakdown: [] };
      const combinedRow: PeriodCombinedRow = {
        rowType: 'period_combined',
        periodKey,
        source: 'combined',
        models: rankedCombinedModels.models,
        modelBreakdown: rankedCombinedModels.modelBreakdown,
        ...periodCombinedTotals,
      };

      rows.push(combinedRow);
    }
  }

  const finalizedGrandTotals =
    events.length === 0 && grandTotals.costUsd === undefined && grandTotals.costIncomplete !== true
      ? { ...grandTotals, costUsd: 0 }
      : grandTotals;

  const rankedGrandModels = includeModelBreakdown
    ? toRankedModelUsage(grandModelTotals)
    : { models: [], modelBreakdown: [] };
  const grandTotalRow: GrandTotalRow = {
    rowType: 'grand_total',
    periodKey: 'ALL',
    source: 'combined',
    models: rankedGrandModels.models,
    modelBreakdown: rankedGrandModels.modelBreakdown,
    ...finalizedGrandTotals,
  };

  rows.push(grandTotalRow);

  return rows;
}
