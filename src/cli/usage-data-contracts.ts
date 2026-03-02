import type { EnvVarOverride } from '../config/env-var-display.js';
import type {
  ParsingRuntimeConfig,
  PricingFetcherRuntimeConfig,
} from '../config/runtime-overrides.js';
import type { UsageReportRow } from '../domain/usage-report-row.js';
import type { UsageEvent } from '../domain/usage-event.js';
import type { EfficiencyRow } from '../efficiency/efficiency-row.js';
import type { OptimizeRow } from '../optimize/optimize-row.js';
import type { PricingSource } from '../pricing/types.js';
import type { SourceAdapter } from '../sources/source-adapter.js';

export type ReportCommandOptions = {
  piDir?: string;
  codexDir?: string;
  geminiDir?: string;
  droidDir?: string;
  opencodeDb?: string;
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
  pricingOffline?: boolean;
  ignorePricingFailures?: boolean;
  share?: boolean;
};

export type EfficiencyCommandOptions = Omit<ReportCommandOptions, 'perModelColumns'> & {
  repoDir?: string;
  includeMergeCommits?: boolean;
};

export type OptimizeCommandOptions = Omit<ReportCommandOptions, 'perModelColumns'> & {
  candidateModel?: string | string[];
  top?: string;
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

export type UsagePricingOrigin = 'cache' | 'network' | 'offline-cache' | 'none';

export type UsageDiagnostics = {
  sessionStats: UsageSessionStats[];
  sourceFailures: UsageSourceFailure[];
  skippedRows: UsageSkippedRowsStat[];
  pricingOrigin: UsagePricingOrigin;
  pricingWarning?: string;
  activeEnvOverrides: EnvVarOverride[];
  timezone: string;
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

export type PricingLoadResult = {
  source: PricingSource;
  origin: Exclude<UsagePricingOrigin, 'none'>;
};

export type BuildUsageDataDeps = {
  getParsingRuntimeConfig?: () => ParsingRuntimeConfig;
  getPricingFetcherRuntimeConfig?: () => PricingFetcherRuntimeConfig;
  createAdapters?: (options: ReportCommandOptions) => SourceAdapter[];
  resolvePricingSource?: (
    options: ReportCommandOptions,
    runtimeConfig: PricingFetcherRuntimeConfig,
  ) => Promise<PricingLoadResult>;
  getActiveEnvVarOverrides?: () => EnvVarOverride[];
};
