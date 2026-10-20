import { buildEventProjectLabels, toProjectKey } from '../aggregate/project-key.js';
import { addEventToTotals } from '../aggregate/aggregate-usage.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';
import { getCurrentLocalDateKey, getPeriodKey } from '../utils/time-buckets.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { normalizeBuildUsageInputs, validateDateInput } from './build-usage-data-inputs.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import {
  applyPricingToUsageEventDataset,
  withPricingNotes,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import { measureRuntimeProfileStage, measureRuntimeProfileStageSync } from './runtime-profile.js';
import type {
  BuildCompareDataDeps,
  CompareCommandOptions,
  CompareDataResult,
  CompareMetricDeltaRatio,
  CompareMetricKey,
  CompareMetricRow,
  CompareSourceRow,
  CompareWindowRange,
  CompareWindowTotals,
} from './usage-data-contracts.js';
import { addUsd } from '../utils/usd-math.js';
import { formatInteger } from '../render/format-number.js';
import { limitRows, parseTopRowsOption, resolveTopRowLimit } from './top-option.js';
import { countDateKeyDays, getMonthEndDateKey, shiftDateKey } from '../utils/date-key.js';
import { computeDeltaRatio } from '../utils/delta-ratio.js';
import {
  createEmptyWindowTotals,
  isEventWithinWindow,
  summarizeUsageWindow,
  type UsageWindowSummary,
} from './usage-window-summary.js';

/** One project's totals in both windows (`--by-repo`), or the projects past --top folded. */
export type CompareProjectRow = Omit<CompareSourceRow, 'source'> &
  (
    | {
        /** The project key, `null` for usage without a repository root. */
        repoRoot: string | null;
        project: string;
      }
    | {
        project: string;
        /** How many projects past --top this row folds. */
        otherProjects: number;
      }
  );

/** Compare data, with one row per project under `--by-repo`. */
export type CompareReportData = CompareDataResult & {
  projects?: CompareProjectRow[];
  /** With --by-repo: names the projects --top folded into the "other projects" row. */
  limitNote?: string;
};

type ResolvedCompareWindows = {
  current: CompareWindowRange;
  baseline: CompareWindowRange;
  combined: {
    since: string;
    until: string;
  };
};

const metricDefinitions: Array<{
  key: CompareMetricKey;
  label: string;
  valueType: CompareMetricRow['valueType'];
}> = [
  { key: 'inputTokens', label: 'Input', valueType: 'integer' },
  { key: 'outputTokens', label: 'Output', valueType: 'integer' },
  { key: 'reasoningTokens', label: 'Reasoning', valueType: 'integer' },
  { key: 'cacheReadTokens', label: 'Cache Read', valueType: 'integer' },
  { key: 'cacheWriteTokens', label: 'Cache Write', valueType: 'integer' },
  { key: 'totalTokens', label: 'Total Tokens', valueType: 'integer' },
  { key: 'costUsd', label: 'Cost', valueType: 'usd' },
  { key: 'events', label: 'Events', valueType: 'integer' },
  { key: 'activeDays', label: 'Active Days', valueType: 'integer' },
];

function getMonthStart(dateKey: string): string {
  return `${dateKey.slice(0, 8)}01`;
}

function getPreviousMonthRange(dateKey: string): CompareWindowRange {
  const until = shiftDateKey(getMonthStart(dateKey), -1);

  return { since: getMonthStart(until), until, label: until.slice(0, 7) };
}

function isFullCalendarMonth(range: { since: string; until: string }): boolean {
  return (
    range.since === getMonthStart(range.since) && range.until === getMonthEndDateKey(range.since)
  );
}

function createRange(since: string, until: string): CompareWindowRange {
  return {
    since,
    until,
    label: isFullCalendarMonth({ since, until }) ? since.slice(0, 7) : `${since} to ${until}`,
  };
}

function createDefaultCurrentWindow(timezone: string, now: Date): CompareWindowRange {
  const currentDate = getCurrentLocalDateKey(timezone, now);
  return createRange(getMonthStart(currentDate), currentDate);
}

/**
 * The default baseline covers the same days of the previous month as the month-to-date
 * current window (clamped to that month's last day), so a partial month is never
 * compared against a full one.
 */
export function createPreviousMonthToDateWindow(
  current: Pick<CompareWindowRange, 'since' | 'until'>,
): CompareWindowRange {
  const previousMonth = getPreviousMonthRange(current.since);
  const sameDayKey = `${previousMonth.since.slice(0, 8)}${current.until.slice(8, 10)}`;
  const until = sameDayKey < previousMonth.until ? sameDayKey : previousMonth.until;

  return createRange(previousMonth.since, until);
}

export function createPreviousSameLengthWindow(
  current: Pick<CompareWindowRange, 'since' | 'until'>,
): CompareWindowRange {
  const dayCount = countDateKeyDays(current.since, current.until);
  const until = shiftDateKey(current.since, -1);
  const since = shiftDateKey(current.since, -dayCount);

  return createRange(since, until);
}

function validateOptionalDate(value: string | undefined, flagName: string): void {
  if (value === undefined) {
    return;
  }

  validateDateInput(value, flagName);
}

export function resolveCompareWindows(
  options: CompareCommandOptions,
  timezone: string,
  now: Date,
): ResolvedCompareWindows {
  validateOptionalDate(options.since, '--since');
  validateOptionalDate(options.until, '--until');
  validateOptionalDate(options.vsSince, '--vs-since');
  validateOptionalDate(options.vsUntil, '--vs-until');

  const hasCurrentSince = options.since !== undefined;
  const hasCurrentUntil = options.until !== undefined;
  const hasBaselineSince = options.vsSince !== undefined;
  const hasBaselineUntil = options.vsUntil !== undefined;

  if (hasCurrentSince !== hasCurrentUntil) {
    throw new Error('compare requires both --since and --until when setting a current window');
  }

  if (hasBaselineSince !== hasBaselineUntil) {
    throw new Error('--vs-since and --vs-until must be provided together');
  }

  if (options.since && options.until && options.since > options.until) {
    throw new Error('--since must be less than or equal to --until');
  }

  if (options.vsSince && options.vsUntil && options.vsSince > options.vsUntil) {
    throw new Error('--vs-since must be less than or equal to --vs-until');
  }

  const current =
    options.since && options.until
      ? createRange(options.since, options.until)
      : createDefaultCurrentWindow(timezone, now);
  const baseline =
    options.vsSince && options.vsUntil
      ? createRange(options.vsSince, options.vsUntil)
      : options.since && options.until
        ? createPreviousSameLengthWindow(current)
        : createPreviousMonthToDateWindow(current);

  return {
    current,
    baseline,
    combined: {
      since: current.since < baseline.since ? current.since : baseline.since,
      until: current.until > baseline.until ? current.until : baseline.until,
    },
  };
}

function resolveMetricValue(
  totals: CompareWindowTotals,
  key: CompareMetricKey,
): number | undefined {
  return totals[key];
}

function subtractValues(
  current: number | undefined,
  baseline: number | undefined,
  valueType: CompareMetricRow['valueType'],
): number | undefined {
  if (current === undefined || baseline === undefined) {
    return undefined;
  }

  if (valueType === 'usd') {
    return addUsd(current, -baseline);
  }

  return current - baseline;
}

function buildMetricRows(
  current: CompareWindowTotals,
  baseline: CompareWindowTotals,
): CompareMetricRow[] {
  return metricDefinitions.map((definition) => {
    const currentValue = resolveMetricValue(current, definition.key);
    const baselineValue = resolveMetricValue(baseline, definition.key);

    return {
      key: definition.key,
      label: definition.label,
      valueType: definition.valueType,
      current: currentValue,
      baseline: baselineValue,
      delta: subtractValues(currentValue, baselineValue, definition.valueType),
      deltaRatio: computeDeltaRatio(currentValue, baselineValue),
      currentCostIncomplete:
        definition.key === 'costUsd' && current.costIncomplete ? true : undefined,
      baselineCostIncomplete:
        definition.key === 'costUsd' && baseline.costIncomplete ? true : undefined,
      deltaCostIncomplete:
        definition.key === 'costUsd' && (current.costIncomplete || baseline.costIncomplete)
          ? true
          : undefined,
    };
  });
}

function diffTotals(
  current: CompareWindowTotals,
  baseline: CompareWindowTotals,
): CompareWindowTotals {
  return {
    inputTokens: current.inputTokens - baseline.inputTokens,
    outputTokens: current.outputTokens - baseline.outputTokens,
    reasoningTokens: current.reasoningTokens - baseline.reasoningTokens,
    cacheReadTokens: current.cacheReadTokens - baseline.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens - baseline.cacheWriteTokens,
    totalTokens: current.totalTokens - baseline.totalTokens,
    costUsd: subtractValues(current.costUsd, baseline.costUsd, 'usd'),
    costIncomplete: current.costIncomplete || baseline.costIncomplete ? true : undefined,
    events: current.events - baseline.events,
    activeDays: current.activeDays - baseline.activeDays,
  };
}

function buildDeltaRatioMap(
  current: CompareWindowTotals,
  baseline: CompareWindowTotals,
): CompareMetricDeltaRatio {
  return Object.fromEntries(
    metricDefinitions.map((definition) => [
      definition.key,
      computeDeltaRatio(
        resolveMetricValue(current, definition.key),
        resolveMetricValue(baseline, definition.key),
      ),
    ]),
  );
}

function sourceSortValue(row: { delta: CompareWindowTotals }): number {
  return Math.abs(row.delta.costUsd ?? 0);
}

function createEmptySideTotals(): CompareWindowTotals {
  return { ...createEmptyWindowTotals(), costUsd: 0 };
}

function compareRowsByCostDelta<Row extends { delta: CompareWindowTotals }>(
  left: Row,
  right: Row,
  toName: (row: Row) => string,
): number {
  const leftSortValue = sourceSortValue(left);
  const rightSortValue = sourceSortValue(right);

  if (leftSortValue !== rightSortValue) {
    return rightSortValue - leftSortValue;
  }

  // Without a price, the token change ranks rows that --top may leave out.
  const tokenChange = Math.abs(right.delta.totalTokens) - Math.abs(left.delta.totalTokens);

  return tokenChange || compareByCodePoint(toName(left), toName(right));
}

function buildSourceRows(current: UsageWindowSummary, baseline: UsageWindowSummary) {
  const sources = new Set([...current.sources.keys(), ...baseline.sources.keys()]);

  return [...sources]
    .map((source) => {
      const currentTotals = current.sources.get(source) ?? createEmptySideTotals();
      const baselineTotals = baseline.sources.get(source) ?? createEmptySideTotals();

      return { source, ...toWindowsRow(currentTotals, baselineTotals) };
    })
    .sort((left, right) => compareRowsByCostDelta(left, right, (row) => row.source));
}

/** Window totals per project key, in one pass over a window's events. */
function summarizeProjects(
  events: readonly UsageEvent[],
  timezone: string,
  toKey: (projectKey: string | undefined) => string | undefined = (projectKey) => projectKey,
): Map<string | undefined, CompareWindowTotals> {
  const projects = new Map<
    string | undefined,
    { totals: CompareWindowTotals; days: Set<string> }
  >();

  for (const event of events) {
    const key = toKey(toProjectKey(event.repoRoot));
    const entry = projects.get(key) ?? { totals: createEmptyWindowTotals(), days: new Set() };
    const { totals } = entry;
    addEventToTotals(totals, event);
    totals.events += 1;

    entry.days.add(getPeriodKey(event.timestamp, 'daily', timezone));
    projects.set(key, entry);
  }

  return new Map(
    [...projects].map(([key, { totals, days }]) => [key, { ...totals, activeDays: days.size }]),
  );
}

/**
 * Per-project rows over both windows. Labels come from one call over both windows' events,
 * so a project has the same label on both sides.
 */
function toWindowsRow(currentTotals: CompareWindowTotals, baselineTotals: CompareWindowTotals) {
  return {
    current: currentTotals,
    baseline: baselineTotals,
    delta: diffTotals(currentTotals, baselineTotals),
    deltaRatio: buildDeltaRatioMap(currentTotals, baselineTotals),
  };
}

/** Totals of the projects past the limit together; their active days count once each. */
function buildOtherProjectsRow(
  currentEvents: readonly UsageEvent[],
  baselineEvents: readonly UsageEvent[],
  timezone: string,
  otherKeys: ReadonlySet<string | undefined>,
): CompareProjectRow {
  const toKey = (projectKey: string | undefined) => (otherKeys.has(projectKey) ? 'other' : 'shown');
  const current = summarizeProjects(currentEvents, timezone, toKey).get('other');
  const baseline = summarizeProjects(baselineEvents, timezone, toKey).get('other');
  const count = otherKeys.size;

  return {
    project: `${formatInteger(count)} other ${count === 1 ? 'project' : 'projects'}`,
    otherProjects: count,
    ...toWindowsRow(current ?? createEmptySideTotals(), baseline ?? createEmptySideTotals()),
  };
}

/** The first `limit` rows by cost change, then one row for the others; with the note. */
function buildProjectRows(
  currentEvents: readonly UsageEvent[],
  baselineEvents: readonly UsageEvent[],
  timezone: string,
  limit: number | undefined,
): { rows: CompareProjectRow[]; limitNote?: string } {
  const projectLabels = buildEventProjectLabels([...currentEvents, ...baselineEvents]);
  const current = summarizeProjects(currentEvents, timezone);
  const baseline = summarizeProjects(baselineEvents, timezone);

  const rows = [...projectLabels]
    .map(([key, project]) => ({
      repoRoot: key ?? null,
      project,
      ...toWindowsRow(
        current.get(key) ?? createEmptySideTotals(),
        baseline.get(key) ?? createEmptySideTotals(),
      ),
    }))
    .sort((left, right) => compareRowsByCostDelta(left, right, (row) => row.project));
  // Folding a single project would hide its name without saving a row.
  const limited = limitRows(
    rows,
    limit === undefined || rows.length <= limit + 1 ? undefined : limit,
    'projects',
    'cost change',
  );

  if (!limited.limitNote) {
    return { rows };
  }

  const otherKeys = new Set(
    rows.slice(limited.rows.length).map((row) => row.repoRoot ?? undefined),
  );

  return {
    rows: [
      ...limited.rows,
      buildOtherProjectsRow(currentEvents, baselineEvents, timezone, otherKeys),
    ],
    limitNote: limited.limitNote,
  };
}

export async function buildCompareData(
  options: CompareCommandOptions,
  deps: BuildCompareDataDeps = {},
): Promise<CompareReportData> {
  const top = parseTopRowsOption(options.top);

  if (top !== undefined && options.byRepo !== true) {
    throw new Error('--top applies with --by-repo');
  }

  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options;
  const normalizedInputs = normalizeBuildUsageInputs(
    configuredOptions,
    userConfigResolution.cliOptions,
  );
  const windows = resolveCompareWindows(
    configuredOptions,
    normalizedInputs.timezone,
    deps.now?.() ?? new Date(),
  );
  const datasetOptions = {
    ...configuredOptions,
    since: windows.combined.since,
    until: windows.combined.until,
    timezone: normalizedInputs.timezone,
  };
  const dataset = await measureRuntimeProfileStage(
    deps.runtimeProfile,
    'compare.dataset.total',
    () =>
      buildUsageEventDataset(datasetOptions, {
        ...deps,
        userConfigResolution: {
          ...userConfigResolution,
          options: datasetOptions,
        },
      }),
  );
  const pricingResult = await applyPricingToUsageEventDataset(dataset, deps, 'auto');
  const { pricedEvents, pricingOrigin, pricingWarning } = pricingResult;
  const currentEvents = pricedEvents.filter((event) =>
    isEventWithinWindow(event, windows.current, dataset.normalizedInputs.timezone),
  );
  const baselineEvents = pricedEvents.filter((event) =>
    isEventWithinWindow(event, windows.baseline, dataset.normalizedInputs.timezone),
  );
  const sourceOrder = dataset.adaptersToParse.map((adapter) => adapter.id);
  const current = measureRuntimeProfileStageSync(
    deps.runtimeProfile,
    'compare.aggregate.current',
    () => summarizeUsageWindow(currentEvents, dataset.normalizedInputs.timezone, sourceOrder),
  );
  const baseline = measureRuntimeProfileStageSync(
    deps.runtimeProfile,
    'compare.aggregate.baseline',
    () => summarizeUsageWindow(baselineEvents, dataset.normalizedInputs.timezone, sourceOrder),
  );
  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    warnings: dataset.warnings,
    notes: withPricingNotes(dataset.notes, [...currentEvents, ...baselineEvents], pricingResult),
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

  const projects = options.byRepo
    ? measureRuntimeProfileStageSync(deps.runtimeProfile, 'compare.aggregate.projects', () =>
        buildProjectRows(
          currentEvents,
          baselineEvents,
          dataset.normalizedInputs.timezone,
          resolveTopRowLimit(top),
        ),
      )
    : undefined;

  return {
    current: {
      window: windows.current,
      totals: current.totals,
    },
    baseline: {
      window: windows.baseline,
      totals: baseline.totals,
    },
    totals: buildMetricRows(current.totals, baseline.totals),
    sources: buildSourceRows(current, baseline),
    projects: projects?.rows,
    ...(projects?.limitNote ? { limitNote: projects.limitNote } : {}),
    diagnostics,
  };
}
