import type { SpawnSsh } from '../machines/machine-ssh.js';
import type { DailyActivity } from '../aggregate/daily-activity.js';
import type { SpendSpike } from '../aggregate/spend-spikes.js';
import type { EnvVarOverride } from '../config/env-var-display.js';
import type { ActiveConfig } from '../config/active-config-display.js';
import type {
  EventStoreRuntimeConfig,
  ParsingRuntimeConfig,
  PricingFetcherRuntimeConfig,
} from '../config/runtime-overrides.js';
import type { LoadedUserConfig } from '../config/user-config.js';
import type { UsageReportRow, UsageTotals } from '../domain/usage-report-row.js';
import type { UsageEvent } from '../domain/usage-event.js';
import type { EfficiencyRow } from '../efficiency/efficiency-row.js';
import type { OptimizeRow } from '../optimize/optimize-row.js';
import type { PricingCostMode, PricingSource } from '@ayagmar/agent-sessions/pricing';
import type {
  EventStoreHistoryResult,
  LoadHistoryEventsInput,
} from '../persistence/event-store-history.js';
import type { EventStore } from '../persistence/event-store.js';
import type { SessionRepoRow, SessionRow } from '../session/session-row.js';
import type { SessionTimelineRow } from '../session/session-timeline.js';
import type { SourceAdapter } from '@ayagmar/agent-sessions';
import type { TrendSeries, TrendsMetric } from '../trends/trends-series.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import type { SourceDirectoryValue } from '../utils/source-directory-overrides.js';
import type { WrappedRecap } from '../wrapped/wrapped-recap.js';
import type { UserConfigResolution } from './apply-user-config.js';
import type { SharedOptionProfile } from './report-definitions/report-definition-types.js';
import type { sharedOptionProfileConfig } from './report-definitions/shared-report-options.js';
import type { RuntimeProfileCollector, RuntimeProfileSnapshot } from './runtime-profile.js';

type SourceSelectionOptions = {
  piDir?: SourceDirectoryValue;
  codexDir?: SourceDirectoryValue;
  copilotDir?: SourceDirectoryValue;
  geminiDir?: SourceDirectoryValue;
  droidDir?: SourceDirectoryValue;
  claudeDir?: SourceDirectoryValue;
  openclawDir?: SourceDirectoryValue;
  opencodeDb?: string;
  gooseDb?: string;
  ampDir?: SourceDirectoryValue;
  qwenDir?: SourceDirectoryValue;
  kimiDir?: SourceDirectoryValue;
  clineDir?: SourceDirectoryValue;
  roocodeDir?: SourceDirectoryValue;
  kilocodeDir?: SourceDirectoryValue;
  antigravityDir?: SourceDirectoryValue;
  dshDir?: SourceDirectoryValue;
  sourceDir?: string[];
  source?: string | string[];
};

type VerboseOption = {
  verbose?: boolean;
};

type JsonOption = {
  json?: boolean;
};

type QuietOption = {
  quiet?: boolean;
};

type DateFilterOptions = {
  since?: string;
  until?: string;
};

type TimezoneOption = {
  timezone?: string;
};

type ProviderModelOptions = {
  provider?: string;
  model?: string | string[];
};

type MarkdownOption = {
  markdown?: boolean;
};

type PerModelColumnsOption = {
  perModelColumns?: boolean;
};

type PricingOptions = {
  pricingOverrides?: string;
};

type CostOptions = {
  ignorePricingFailures?: boolean;
  /** `--cost-mode`; undefined when not passed, which prices as `both`. */
  costMode?: PricingCostMode;
};

type PricingFetchOptions = {
  pricingUrl?: string;
  pricingOffline?: boolean;
};

type HistoryOption = {
  history?: boolean;
  /** Machines to count, by name; `local` is this one. Default: all. */
  machine?: string | string[];
};

type SyncOption = {
  /** False with --no-sync: use other machines' cached usage without refreshing it. */
  sync?: boolean;
};

type ShareOption = {
  share?: boolean;
  /** False with --no-open: write the share report without opening it. */
  open?: boolean;
  /** With --share: replace project and machine names in the report. */
  redact?: boolean;
};

type ProfileConfig = typeof sharedOptionProfileConfig;

// Keep command option types derived from the same profile booleans that register the flags.
type SharedOptionsForProfile<P extends SharedOptionProfile> =
  (ProfileConfig[P]['includeSources'] extends true ? SourceSelectionOptions : unknown) &
    (ProfileConfig[P]['includeVerbose'] extends true ? VerboseOption : unknown) &
    (ProfileConfig[P]['includeJson'] extends true ? JsonOption : unknown) &
    (ProfileConfig[P]['includeQuiet'] extends true ? QuietOption : unknown) &
    (ProfileConfig[P]['includeDateFilters'] extends true ? DateFilterOptions : unknown) &
    (ProfileConfig[P]['includeTimezone'] extends true ? TimezoneOption : unknown) &
    (ProfileConfig[P]['includeProviderModelFilters'] extends true
      ? ProviderModelOptions
      : unknown) &
    (ProfileConfig[P]['includePricing'] extends true ? PricingOptions : unknown) &
    (ProfileConfig[P]['includeCostOptions'] extends true ? CostOptions : unknown) &
    (ProfileConfig[P]['includePricingFetch'] extends true ? PricingFetchOptions : unknown) &
    (ProfileConfig[P]['includeHistory'] extends true ? HistoryOption : unknown) &
    (ProfileConfig[P]['includeSync'] extends true ? SyncOption : unknown) &
    (ProfileConfig[P]['includeMarkdown'] extends true ? MarkdownOption : unknown) &
    (ProfileConfig[P]['includePerModelColumns'] extends true ? PerModelColumnsOption : unknown) &
    (ProfileConfig[P]['includeShare'] extends true ? ShareOption : unknown);

/** `--repo`: count only these projects (repeatable or comma-separated). */
type RepoFilterOption = {
  repo?: string | string[];
};

/** `--by-repo`: split the report by project. */
type ByRepoOption = {
  byRepo?: boolean;
};

/** `--compact` and `--no-cost`, as on the usage reports. */
type TableDisplayOptions = {
  /** `false` with `--no-cost`: tables leave out cost. */
  cost?: boolean;
  /** Abbreviated token counts without the Reasoning and Cache Write columns. */
  compact?: boolean;
};

export type ReportCommandOptions = SharedOptionsForProfile<'usage'> &
  RepoFilterOption &
  ByRepoOption & {
    /** Full history instead of the default recent window (a no-op on `monthly`). */
    all?: boolean;
    /** `--last N`: the last N periods of the granularity, counting the current one. */
    last?: string;
    /** `false` with `--no-cost`: tables and the share report leave out cost. */
    cost?: boolean;
    /** Abbreviated token counts without the Reasoning and Cache Write columns. */
    compact?: boolean;
    /** One row per source and machine instead of per source. */
    byMachine?: boolean;
    /** With --by-repo: projects shown per period (default 20; 0 shows all). */
    top?: string;
  };

export type HourlyCommandOptions = SharedOptionsForProfile<'hourly'> &
  RepoFilterOption &
  ByRepoOption &
  TableDisplayOptions & {
    /** `--last N`: the last N days (1-31), hour by hour, counting today. */
    last?: string;
    /** Every hour instead of today. */
    all?: boolean;
    /** One row per source and machine instead of per source. */
    byMachine?: boolean;
    /** With --by-repo: projects shown per hour (default 20; 0 shows all). */
    top?: string;
  };

/** Shared by projects, blocks and value: the window flags and the table display flags. */
type RollupCommandOptions = SharedOptionsForProfile<'rollup'> &
  RepoFilterOption &
  TableDisplayOptions & {
    /** `--last N`: the last N periods of the report's unit, counting the current one. */
    last?: string;
    all?: boolean;
  };

export type ProjectsCommandOptions = RollupCommandOptions & {
  /** Adds rows per period and project. */
  granularity?: ReportGranularity;
  top?: string;
};

export type BlocksCommandOptions = RollupCommandOptions & {
  top?: string;
};

export type ToolsCommandOptions = SharedOptionsForProfile<'tools'> &
  RepoFilterOption &
  ByRepoOption & {
    /** `--last N`: the last N days, counting today. */
    last?: string;
    all?: boolean;
    top?: string;
    bySource?: boolean;
  };

export type ValueCommandOptions = RollupCommandOptions & {
  /** Plan ids from `src/value/plans.ts`; undefined when not passed. */
  plan?: string[];
  planPrice?: string;
  /** Projects listed per month (default 10; 0 lists all). */
  top?: string;
};

export type PricingCommandOptions = SharedOptionsForProfile<'pricing'>;

export type SummaryCommandOptions = SharedOptionsForProfile<'summary'> & RepoFilterOption;

export type StatuslineCommandOptions = SharedOptionsForProfile<'statusline'>;

export type EfficiencyCommandOptions = SharedOptionsForProfile<'specialized'> &
  RepoFilterOption & {
    repoDir?: string;
    includeMergeCommits?: boolean;
    bySource?: boolean;
  };

export type OptimizeCommandOptions = SharedOptionsForProfile<'specialized'> &
  RepoFilterOption & {
    candidateModel?: string | string[];
    top?: string;
  };

export type TrendsCommandOptions = SharedOptionsForProfile<'trends'> &
  RepoFilterOption &
  ByRepoOption & {
    last?: string;
    /** Hidden alias of `last`. */
    days?: string;
    /** Every day since the first usage instead of the last 30. */
    all?: boolean;
    metric?: string;
    bySource?: boolean;
  };

export type SessionCommandOptions = SharedOptionsForProfile<'session'> &
  RepoFilterOption & {
    top?: string;
    id?: string[];
    byRepo?: boolean;
    timeline?: boolean;
  };

export type ContextCommandOptions = SharedOptionsForProfile<'session'> &
  RepoFilterOption & {
    /** `--last N`: the last N days, counting today. */
    last?: string;
    /** Full history instead of the default recent window. */
    all?: boolean;
    top?: string;
    bySession?: boolean;
  };

export type CompareCommandOptions = SharedOptionsForProfile<'compare'> &
  RepoFilterOption &
  ByRepoOption & {
    vsSince?: string;
    vsUntil?: string;
    /** With --by-repo: projects shown (default 20; 0 shows all). */
    top?: string;
  };

export type WrappedCommandOptions = SharedOptionsForProfile<'wrapped'> & {
  year?: string;
};

export type EventsCommandOptions = SharedOptionsForProfile<'events'> &
  RepoFilterOption & {
    /** `--last N`: the last N days, counting today. */
    last?: string;
    /** Full history, the default without date flags. */
    all?: boolean;
    format?: string;
    otelIncludePaths?: boolean;
    otlpEndpoint?: string;
  };

export type DoctorCommandOptions = SharedOptionsForProfile<'doctor'>;

export type ConfigShowCommandOptions = SharedOptionsForProfile<'config'>;

export type PruneCommandOptions = DoctorCommandOptions & {
  suppressed?: boolean;
  departedBefore?: string;
  apply?: boolean;
};

export type UsageSessionStats = {
  source: string;
  filesFound: number;
  eventsParsed: number;
};

export type UsageSourceFailure = {
  source: string;
  reason: string;
};

export type UsageSkippedRowReasonStat = {
  reason: string;
  count: number;
};

export type UsageSkippedRowsStat = {
  source: string;
  skippedRows: number;
  reasons?: UsageSkippedRowReasonStat[];
};

export type UsagePricingOrigin =
  'cache' | 'network' | 'offline-cache' | 'bundled-snapshot' | 'none';

/**
 * A stderr note. A plain string prints by default; a `verbose` note is routine detail
 * (scan counts, history, machines, re-estimated costs) that prints only under `--verbose`.
 */
export type ReportNote = string | { verbose: string };

export type UsageDiagnostics = {
  sessionStats: UsageSessionStats[];
  sourceFailures: UsageSourceFailure[];
  skippedRows: UsageSkippedRowsStat[];
  pricingOrigin: UsagePricingOrigin;
  pricingWarning?: string;
  warnings?: string[];
  /** Informational lines; not problems. */
  notes?: ReportNote[];
  activeEnvOverrides: EnvVarOverride[];
  activeConfig?: ActiveConfig;
  timezone: string;
  runtimeProfile?: RuntimeProfileSnapshot;
};

export type UsageDataResult = {
  events: UsageEvent[];
  rows: UsageReportRow[];
  diagnostics: UsageDiagnostics;
  /** With --by-repo: names the projects that --top folded into "other projects" rows. */
  limitNote?: string;
  /** Set when `daily` ran without dates and so covered only its default recent window. */
  defaultWindowSince?: string;
};

export type EfficiencyDiagnostics = UsageDiagnostics & {
  repoDir: string;
  includeMergeCommits: boolean;
  gitCommitCount: number;
  gitLinesAdded: number;
  gitLinesDeleted: number;
  gitMalformedCommitLines: number;
  repoMatchedUsageEvents: number;
  /** Days with token or cost usage in the repository; commits are only counted on these. */
  repoUsageDays: number;
  repoExcludedUsageEvents: number;
  repoUnattributedUsageEvents: number;
  scopeNote?: string;
};

export type EfficiencyDataResult = {
  grouping: 'period' | 'source';
  rows: EfficiencyRow[];
  diagnostics: EfficiencyDiagnostics;
};

export type OptimizeDiagnostics = UsageDiagnostics & {
  provider: string;
  /** Set when, with no --provider, the candidates' provider scoped a multi-provider run. */
  inferredProvider?: string;
  baselineCostIncomplete: boolean;
  candidatesWithMissingPricing: string[];
  warning?: string;
};

export type OptimizeDataResult = {
  rows: OptimizeRow[];
  diagnostics: OptimizeDiagnostics;
};

export type TrendsDataResult = {
  metric: TrendsMetric;
  dateRange: {
    from: string;
    to: string;
  };
  totalSeries: TrendSeries;
  sourceSeries?: TrendSeries[];
  diagnostics: UsageDiagnostics;
};

export type SessionDataResult =
  | {
      grouping: 'session';
      rows: SessionRow[];
      /** Rows before --top. */
      rowCount: number;
      /** Labels over every project in the report's events, not only the shown rows. */
      projectLabels: ReadonlyMap<string | undefined, string>;
      limitNote?: string;
      diagnostics: UsageDiagnostics;
    }
  | {
      grouping: 'repo';
      rows: SessionRepoRow[];
      /** Rows before --top. */
      rowCount: number;
      projectLabels: ReadonlyMap<string | undefined, string>;
      limitNote?: string;
      diagnostics: UsageDiagnostics;
    }
  | {
      /** `--timeline`: the one session `--id` matched, request by request. */
      grouping: 'timeline';
      session: SessionRow;
      rows: SessionTimelineRow[];
      projectLabels: ReadonlyMap<string | undefined, string>;
      limitNote?: undefined;
      diagnostics: UsageDiagnostics;
    };

export type CompareWindowRange = {
  since: string;
  until: string;
  label: string;
};

export type UsageWindowTotals = UsageTotals & {
  events: number;
  activeDays: number;
};

export type CompareWindowTotals = UsageWindowTotals;

export type SummaryPeriodKey = 'today' | 'last7Days' | 'monthToDate';

export type SummarySourceTotals = UsageWindowTotals & {
  source: string;
};

export type SummaryMachineTotals = UsageWindowTotals & {
  /** `local` for this machine, otherwise the name it was added under. */
  machine: string;
};

export type SummaryPeriod = {
  key: SummaryPeriodKey;
  label: string;
  since: string;
  until: string;
  totals: UsageWindowTotals;
  /** Sources with usage in the period, by cost then name. */
  sources: SummarySourceTotals[];
  /**
   * Machines with usage in the period, by cost then tokens then name; present only
   * when the report counts other machines' usage (after its filters) in the past year.
   */
  machines?: SummaryMachineTotals[];
  /**
   * The window the period is set against, as `compare` picks it; always set by
   * `buildSummaryData`.
   */
  previous?: SummaryPreviousPeriod;
};

export type SummaryPreviousPeriod = {
  since: string;
  until: string;
  totals: UsageWindowTotals;
};

/** Month-to-date run rate and the configured budget. */
export type SummaryMonthEnd = {
  daysElapsed: number;
  daysInMonth: number;
  /** Month-to-date cost scaled to the whole month; absent before day 3, without usage, or without a known cost. */
  projectedCostUsd?: number;
  costIncomplete?: boolean;
  /** `monthlyBudgetUsd` from the config file; absent when --source, --provider, or --model narrows the run. */
  budgetUsd?: number;
};

/** The costliest spike day of the last 7 days, and what drove it. */
export type SummarySpendSpike = SpendSpike & {
  costIncomplete?: boolean;
  /** Label of the project with the largest share of the day's cost. */
  project?: string;
  /** The model with the largest share of the day's cost. */
  model?: string;
};

export type SummaryDataResult = {
  timezone: string;
  periods: SummaryPeriod[];
  monthEnd: SummaryMonthEnd;
  /** Estimated month-to-date savings from cache reads; absent without cache reads to price. */
  monthToDateCacheSavingsUsd?: number;
  /** Daily activity over the past 53 ISO weeks, ending today. */
  activity: DailyActivity;
  /** Absent when no day of the last 7 is a spend spike. */
  spike?: SummarySpendSpike;
  diagnostics: UsageDiagnostics;
};

export type CompareMetricKey =
  | 'inputTokens'
  | 'outputTokens'
  | 'reasoningTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'totalTokens'
  | 'costUsd'
  | 'events'
  | 'activeDays';

export type CompareMetricRow = {
  key: CompareMetricKey;
  label: string;
  valueType: 'integer' | 'usd';
  current: number | undefined;
  baseline: number | undefined;
  delta: number | undefined;
  deltaRatio: number | undefined;
  currentCostIncomplete?: boolean;
  baselineCostIncomplete?: boolean;
  deltaCostIncomplete?: boolean;
};

export type CompareMetricDeltaRatio = Partial<Record<CompareMetricKey, number | undefined>>;

export type CompareSourceRow = {
  source: string;
  current: CompareWindowTotals;
  baseline: CompareWindowTotals;
  delta: CompareWindowTotals;
  deltaRatio: CompareMetricDeltaRatio;
};

export type CompareDataResult = {
  current: {
    window: CompareWindowRange;
    totals: CompareWindowTotals;
  };
  baseline: {
    window: CompareWindowRange;
    totals: CompareWindowTotals;
  };
  totals: CompareMetricRow[];
  sources: CompareSourceRow[];
  diagnostics: UsageDiagnostics;
};

export type WrappedDataResult = {
  recap: WrappedRecap;
  diagnostics: UsageDiagnostics;
};

export type PricingLoadResult = {
  source: PricingSource;
  origin: Exclude<UsagePricingOrigin, 'none'>;
  warning?: string;
};

export type BuildUsageDataDeps = {
  getParsingRuntimeConfig?: (
    env?: NodeJS.ProcessEnv,
    config?: LoadedUserConfig['config'],
    writesEventStore?: boolean,
  ) => ParsingRuntimeConfig;
  getPricingFetcherRuntimeConfig?: (
    config?: LoadedUserConfig['config'],
  ) => PricingFetcherRuntimeConfig;
  getEventStoreRuntimeConfig?: (
    env?: NodeJS.ProcessEnv,
    config?: LoadedUserConfig['config'],
  ) => EventStoreRuntimeConfig;
  loadUserConfig?: () => Promise<LoadedUserConfig>;
  userConfigResolution?: UserConfigResolution;
  createAdapters?: (options: ReportCommandOptions) => SourceAdapter[];
  openEventStore?: (filePath: string) => Promise<EventStore>;
  closeEventStore?: (store: EventStore) => void;
  resolvePricingSource?: (
    options: ReportCommandOptions,
    runtimeConfig: PricingFetcherRuntimeConfig,
  ) => Promise<PricingLoadResult>;
  getActiveEnvVarOverrides?: () => EnvVarOverride[];
  loadHistoryEvents?: (store: EventStore, input: LoadHistoryEventsInput) => EventStoreHistoryResult;
  runtimeProfile?: RuntimeProfileCollector;
  now?: () => Date;
  /** Stands in for ssh when other machines are refreshed. */
  spawnSsh?: SpawnSsh;
};

export type BuildTrendsDataDeps = BuildUsageDataDeps & {
  now?: () => Date;
};

export type BuildSessionDataDeps = BuildUsageDataDeps;

export type BuildWrappedDataDeps = BuildUsageDataDeps & {
  now?: () => Date;
};

export type BuildCompareDataDeps = BuildUsageDataDeps;

export type BuildSummaryDataDeps = BuildUsageDataDeps;
