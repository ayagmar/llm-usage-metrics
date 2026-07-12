import { aggregateUsage } from '../aggregate/aggregate-usage.js';
import type { UsageReportRow, UsageTotals } from '../domain/usage-report-row.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getCurrentLocalDateKey, getPeriodKey, shiftLocalDateKey } from '../utils/time-buckets.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { normalizeBuildUsageInputs, validateDateInput } from './build-usage-data-inputs.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import {
  applyPricingToUsageEventDataset,
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
  CompareWindowRange,
  CompareWindowTotals,
} from './usage-data-contracts.js';

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type ResolvedCompareWindows = {
  current: CompareWindowRange;
  baseline: CompareWindowRange;
  combined: {
    since: string;
    until: string;
  };
};

type WindowSummary = {
  totals: CompareWindowTotals;
  sources: Map<string, CompareWindowTotals>;
};

const USD_PRECISION_SCALE = 1_000_000_000_000;

const metricDefinitions: Array<{
  key: CompareMetricKey;
  label: string;
  valueType: CompareMetricRow['valueType'];
}> = [
  { key: 'inputTokens', label: 'Input', valueType: 'integer' },
  { key: 'outputTokens', label: 'Output', valueType: 'integer' },
  { key: 'reasoningTokens', label: 'Reasoning', valueType: 'integer' },
  { key: 'cacheReadTokens', label: 'Cache read', valueType: 'integer' },
  { key: 'cacheWriteTokens', label: 'Cache write', valueType: 'integer' },
  { key: 'totalTokens', label: 'Total tokens', valueType: 'integer' },
  { key: 'costUsd', label: 'Cost', valueType: 'usd' },
  { key: 'events', label: 'Events', valueType: 'integer' },
  { key: 'activeDays', label: 'Active days', valueType: 'integer' },
];

function parseDateKey(value: string): DateParts {
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));

  return { year, month, day };
}

function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getMonthStart(dateKey: string): string {
  const { year, month } = parseDateKey(dateKey);
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function getMonthEnd(dateKey: string): string {
  const { year, month } = parseDateKey(dateKey);
  return formatDateKey(new Date(Date.UTC(year, month, 0)));
}

function getPreviousMonthRange(dateKey: string): CompareWindowRange {
  const { year, month } = parseDateKey(dateKey);
  const previousMonthDay = formatDateKey(new Date(Date.UTC(year, month - 2, 1)));

  return {
    since: getMonthStart(previousMonthDay),
    until: getMonthEnd(previousMonthDay),
    label: previousMonthDay.slice(0, 7),
  };
}

function countInclusiveDays(since: string, until: string): number {
  const sinceMs = new Date(`${since}T00:00:00.000Z`).getTime();
  const untilMs = new Date(`${until}T00:00:00.000Z`).getTime();
  return Math.floor((untilMs - sinceMs) / (24 * 60 * 60 * 1000)) + 1;
}

function isFullCalendarMonth(range: { since: string; until: string }): boolean {
  return range.since === getMonthStart(range.since) && range.until === getMonthEnd(range.since);
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
  return createRange(getMonthStart(currentDate), getMonthEnd(currentDate));
}

function createPreviousSameLengthWindow(current: CompareWindowRange): CompareWindowRange {
  const dayCount = countInclusiveDays(current.since, current.until);
  const until = shiftLocalDateKey(current.since, -1);
  const since = shiftLocalDateKey(current.since, -dayCount);

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
        : getPreviousMonthRange(current.since);

  return {
    current,
    baseline,
    combined: {
      since: current.since < baseline.since ? current.since : baseline.since,
      until: current.until > baseline.until ? current.until : baseline.until,
    },
  };
}

function isEventWithinWindow(
  event: UsageEvent,
  window: CompareWindowRange,
  timezone: string,
): boolean {
  const eventDate = getPeriodKey(event.timestamp, 'daily', timezone);
  return eventDate >= window.since && eventDate <= window.until;
}

function createEmptyTotals(): CompareWindowTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    events: 0,
    activeDays: 0,
  };
}

function addUsd(left: number, right: number): number {
  return Math.round((left + right) * USD_PRECISION_SCALE) / USD_PRECISION_SCALE;
}

function addUsageTotals(target: CompareWindowTotals, source: UsageTotals): void {
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

function activeDaysBySource(
  events: UsageEvent[],
  timezone: string,
): {
  totalDays: Set<string>;
  sourceDays: Map<string, Set<string>>;
} {
  const totalDays = new Set<string>();
  const sourceDays = new Map<string, Set<string>>();

  for (const event of events) {
    const day = getPeriodKey(event.timestamp, 'daily', timezone);
    totalDays.add(day);

    const days = sourceDays.get(event.source) ?? new Set<string>();
    days.add(day);
    sourceDays.set(event.source, days);
  }

  return { totalDays, sourceDays };
}

function eventCountsBySource(events: UsageEvent[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const event of events) {
    counts.set(event.source, (counts.get(event.source) ?? 0) + 1);
  }

  return counts;
}

function findGrandTotal(rows: UsageReportRow[]): UsageTotals {
  const grandTotal = rows.find((row) => row.rowType === 'grand_total');

  if (!grandTotal) {
    return createEmptyTotals();
  }

  return grandTotal;
}

function summarizeWindow(
  events: UsageEvent[],
  timezone: string,
  sourceOrder: string[],
): WindowSummary {
  const rows = aggregateUsage(events, {
    granularity: 'daily',
    timezone,
    sourceOrder,
    includeModelBreakdown: false,
  });
  const sourceCounts = eventCountsBySource(events);
  const activeDays = activeDaysBySource(events, timezone);
  const totals = createEmptyTotals();
  addUsageTotals(totals, findGrandTotal(rows));
  totals.events = events.length;
  totals.activeDays = activeDays.totalDays.size;

  const sources = new Map<string, CompareWindowTotals>();

  for (const row of rows) {
    if (row.rowType !== 'period_source') {
      continue;
    }

    const sourceTotals = sources.get(row.source) ?? createEmptyTotals();
    addUsageTotals(sourceTotals, row);
    sources.set(row.source, sourceTotals);
  }

  for (const [source, sourceTotals] of sources) {
    sourceTotals.events = sourceCounts.get(source) ?? 0;
    sourceTotals.activeDays = activeDays.sourceDays.get(source)?.size ?? 0;
  }

  return { totals, sources };
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

function computeDeltaRatio(
  current: number | undefined,
  baseline: number | undefined,
): number | undefined {
  if (current === undefined || baseline === undefined) {
    return undefined;
  }

  if (baseline === 0) {
    return current === 0 ? 0 : undefined;
  }

  return (current - baseline) / baseline;
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

function buildSourceRows(current: WindowSummary, baseline: WindowSummary) {
  const sources = new Set([...current.sources.keys(), ...baseline.sources.keys()]);

  return [...sources]
    .map((source) => {
      const currentTotals = current.sources.get(source) ?? { ...createEmptyTotals(), costUsd: 0 };
      const baselineTotals = baseline.sources.get(source) ?? { ...createEmptyTotals(), costUsd: 0 };

      return {
        source,
        current: currentTotals,
        baseline: baselineTotals,
        delta: diffTotals(currentTotals, baselineTotals),
        deltaRatio: buildDeltaRatioMap(currentTotals, baselineTotals),
      };
    })
    .sort((left, right) => {
      const leftSortValue = sourceSortValue(left);
      const rightSortValue = sourceSortValue(right);

      if (leftSortValue !== rightSortValue) {
        return rightSortValue - leftSortValue;
      }

      return compareByCodePoint(left.source, right.source);
    });
}

export async function buildCompareData(
  options: CompareCommandOptions,
  deps: BuildCompareDataDeps = {},
): Promise<CompareDataResult> {
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options;
  const normalizedInputs = normalizeBuildUsageInputs(configuredOptions);
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
  const { pricedEvents, pricingOrigin, pricingWarning } = await applyPricingToUsageEventDataset(
    dataset,
    deps,
    'auto',
  );
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
    () => summarizeWindow(currentEvents, dataset.normalizedInputs.timezone, sourceOrder),
  );
  const baseline = measureRuntimeProfileStageSync(
    deps.runtimeProfile,
    'compare.aggregate.baseline',
    () => summarizeWindow(baselineEvents, dataset.normalizedInputs.timezone, sourceOrder),
  );
  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    warnings: dataset.warnings,
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone: dataset.normalizedInputs.timezone,
    runtimeProfile: deps.runtimeProfile?.snapshot(),
  });

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
    diagnostics,
  };
}
