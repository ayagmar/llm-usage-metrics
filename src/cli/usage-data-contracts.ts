import type { EnvVarOverride } from '../config/env-var-display.js';
import type { ActiveConfig } from '../config/active-config-display.js';
import type {
  EventStoreRuntimeConfig,
  ParsingRuntimeConfig,
  PricingFetcherRuntimeConfig,
} from '../config/runtime-overrides.js';
import type { LoadedUserConfig } from '../config/user-config.js';
import type { UsageReportRow } from '../domain/usage-report-row.js';
import type { UsageEvent } from '../domain/usage-event.js';
import type { EfficiencyRow } from '../efficiency/efficiency-row.js';
import type { OptimizeRow } from '../optimize/optimize-row.js';
import type { PricingSource } from '../pricing/types.js';
import type {
  EventStoreHistoryResult,
  LoadHistoryEventsInput,
} from '../persistence/event-store-history.js';
import type { EventStore } from '../persistence/event-store.js';
import type { SessionRepoRow, SessionRow } from '../session/session-row.js';
import type { SourceAdapter } from '../sources/source-adapter.js';
import type { TrendSeries, TrendsMetric } from '../trends/trends-series.js';
import type { WrappedRecap } from '../wrapped/wrapped-recap.js';
import type { UserConfigResolution } from './apply-user-config.js';
import type { RuntimeProfileCollector, RuntimeProfileSnapshot } from './runtime-profile.js';

export type ReportCommandOptions = {
  piDir?: string;
  codexDir?: string;
  copilotDir?: string;
  geminiDir?: string;
  droidDir?: string;
  claudeDir?: string;
  openclawDir?: string;
  opencodeDb?: string;
  gooseDb?: string;
  ampDir?: string;
  qwenDir?: string;
  kimiDir?: string;
  clineDir?: string;
  roocodeDir?: string;
  kilocodeDir?: string;
  antigravityDir?: string;
  sourceDir?: string[];
  source?: string | string[];
  since?: string;
  until?: string;
  timezone?: string;
  provider?: string;
  model?: string | string[];
  markdown?: boolean;
  json?: boolean;
  perModelColumns?: boolean;
  pricingUrl?: string;
  pricingOverrides?: string;
  pricingOffline?: boolean;
  ignorePricingFailures?: boolean;
  history?: boolean;
  share?: boolean;
};

export type EfficiencyCommandOptions = Omit<ReportCommandOptions, 'perModelColumns'> & {
  repoDir?: string;
  includeMergeCommits?: boolean;
  bySource?: boolean;
};

export type OptimizeCommandOptions = Omit<ReportCommandOptions, 'perModelColumns'> & {
  candidateModel?: string | string[];
  top?: string;
};

export type TrendsCommandOptions = Omit<ReportCommandOptions, 'markdown' | 'perModelColumns'> & {
  days?: string;
  metric?: string;
  bySource?: boolean;
};

export type SessionCommandOptions = Omit<ReportCommandOptions, 'perModelColumns' | 'share'> & {
  top?: string;
  id?: string[];
  byRepo?: boolean;
};

export type CompareCommandOptions = Omit<ReportCommandOptions, 'perModelColumns' | 'share'> & {
  vsSince?: string;
  vsUntil?: string;
};

export type WrappedCommandOptions = Omit<
  ReportCommandOptions,
  'markdown' | 'perModelColumns' | 'provider' | 'model' | 'since' | 'until'
> & {
  year?: string;
};

export type DoctorCommandOptions = Pick<
  ReportCommandOptions,
  | 'piDir'
  | 'codexDir'
  | 'copilotDir'
  | 'geminiDir'
  | 'droidDir'
  | 'claudeDir'
  | 'openclawDir'
  | 'opencodeDb'
  | 'gooseDb'
  | 'ampDir'
  | 'qwenDir'
  | 'kimiDir'
  | 'clineDir'
  | 'roocodeDir'
  | 'kilocodeDir'
  | 'antigravityDir'
  | 'sourceDir'
  | 'source'
  | 'json'
>;

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
  | 'cache'
  | 'network'
  | 'offline-cache'
  | 'bundled-snapshot'
  | 'none';

export type UsageDiagnostics = {
  sessionStats: UsageSessionStats[];
  sourceFailures: UsageSourceFailure[];
  skippedRows: UsageSkippedRowsStat[];
  pricingOrigin: UsagePricingOrigin;
  pricingWarning?: string;
  warnings?: string[];
  activeEnvOverrides: EnvVarOverride[];
  activeConfig?: ActiveConfig;
  timezone: string;
  runtimeProfile?: RuntimeProfileSnapshot;
};

export type UsageDataResult = {
  events: UsageEvent[];
  rows: UsageReportRow[];
  diagnostics: UsageDiagnostics;
};

export type EfficiencyDiagnostics = {
  usage: UsageDiagnostics;
  repoDir: string;
  includeMergeCommits: boolean;
  gitCommitCount: number;
  gitLinesAdded: number;
  gitLinesDeleted: number;
  repoMatchedUsageEvents: number;
  repoExcludedUsageEvents: number;
  repoUnattributedUsageEvents: number;
  scopeNote?: string;
};

export type EfficiencyDataResult = {
  grouping: 'period' | 'source';
  rows: EfficiencyRow[];
  diagnostics: EfficiencyDiagnostics;
};

export type OptimizeDiagnostics = {
  usage: UsageDiagnostics;
  provider: string;
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
      limitNote?: string;
      diagnostics: UsageDiagnostics;
    }
  | {
      grouping: 'repo';
      rows: SessionRepoRow[];
      limitNote?: string;
      diagnostics: UsageDiagnostics;
    };

export type CompareWindowRange = {
  since: string;
  until: string;
  label: string;
};

export type CompareWindowTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
  costIncomplete?: boolean;
  events: number;
  activeDays: number;
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
  deltaPercent: number | undefined;
  currentCostIncomplete?: boolean;
  baselineCostIncomplete?: boolean;
  deltaCostIncomplete?: boolean;
};

export type CompareMetricDeltaPercent = Partial<Record<CompareMetricKey, number | undefined>>;

export type CompareSourceRow = {
  source: string;
  current: CompareWindowTotals;
  baseline: CompareWindowTotals;
  delta: CompareWindowTotals;
  deltaPercent: CompareMetricDeltaPercent;
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
  ) => ParsingRuntimeConfig;
  getPricingFetcherRuntimeConfig?: (
    env?: NodeJS.ProcessEnv,
    config?: LoadedUserConfig['config'],
  ) => PricingFetcherRuntimeConfig;
  getEventStoreRuntimeConfig?: (
    env?: NodeJS.ProcessEnv,
    config?: LoadedUserConfig['config'],
  ) => EventStoreRuntimeConfig;
  loadUserConfig?: () => Promise<LoadedUserConfig>;
  userConfigResolution?: UserConfigResolution;
  createAdapters?: (options: ReportCommandOptions) => SourceAdapter[];
  resolvePricingSource?: (
    options: ReportCommandOptions,
    runtimeConfig: PricingFetcherRuntimeConfig,
  ) => Promise<PricingLoadResult>;
  getActiveEnvVarOverrides?: () => EnvVarOverride[];
  loadHistoryEvents?: (store: EventStore, input: LoadHistoryEventsInput) => EventStoreHistoryResult;
  runtimeProfile?: RuntimeProfileCollector;
};

export type BuildTrendsDataDeps = BuildUsageDataDeps & {
  now?: () => Date;
};

export type BuildSessionDataDeps = BuildUsageDataDeps;

export type BuildWrappedDataDeps = BuildUsageDataDeps & {
  now?: () => Date;
};

export type BuildCompareDataDeps = BuildUsageDataDeps & {
  now?: () => Date;
};
