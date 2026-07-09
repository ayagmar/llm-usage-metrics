import { describe, expectTypeOf, it } from 'vitest';

import type {
  CompareCommandOptions,
  DoctorCommandOptions,
  EfficiencyCommandOptions,
  OptimizeCommandOptions,
  PruneCommandOptions,
  ReportCommandOptions,
  SessionCommandOptions,
  TrendsCommandOptions,
  WrappedCommandOptions,
} from '../../src/cli/usage-data-contracts.js';

type ReportCommandOptions_Old = {
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

type LegacyEfficiencyCommandOptions = Omit<ReportCommandOptions_Old, 'perModelColumns'> & {
  repoDir?: string;
  includeMergeCommits?: boolean;
  bySource?: boolean;
};

type LegacyOptimizeCommandOptions = Omit<ReportCommandOptions_Old, 'perModelColumns'> & {
  candidateModel?: string | string[];
  top?: string;
};

type LegacyTrendsCommandOptions = Omit<ReportCommandOptions_Old, 'markdown' | 'perModelColumns'> & {
  days?: string;
  metric?: string;
  bySource?: boolean;
};

type LegacySessionCommandOptions = Omit<ReportCommandOptions_Old, 'perModelColumns' | 'share'> & {
  top?: string;
  id?: string[];
  byRepo?: boolean;
};

type LegacyCompareCommandOptions = Omit<ReportCommandOptions_Old, 'perModelColumns' | 'share'> & {
  vsSince?: string;
  vsUntil?: string;
};

type LegacyWrappedCommandOptions = Omit<
  ReportCommandOptions_Old,
  'markdown' | 'perModelColumns' | 'since' | 'until'
> & {
  year?: string;
};

type LegacyDoctorCommandOptions = Pick<
  ReportCommandOptions_Old,
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

type LegacyPruneCommandOptions = LegacyDoctorCommandOptions & {
  suppressed?: boolean;
  departedBefore?: string;
  apply?: boolean;
};

describe('command option contract types', () => {
  it('match the legacy command option shapes', () => {
    expectTypeOf<ReportCommandOptions>().toExtend<ReportCommandOptions_Old>();
    expectTypeOf<ReportCommandOptions_Old>().toExtend<ReportCommandOptions>();
    expectTypeOf<EfficiencyCommandOptions>().toExtend<LegacyEfficiencyCommandOptions>();
    expectTypeOf<LegacyEfficiencyCommandOptions>().toExtend<EfficiencyCommandOptions>();
    expectTypeOf<OptimizeCommandOptions>().toExtend<LegacyOptimizeCommandOptions>();
    expectTypeOf<LegacyOptimizeCommandOptions>().toExtend<OptimizeCommandOptions>();
    expectTypeOf<TrendsCommandOptions>().toExtend<LegacyTrendsCommandOptions>();
    expectTypeOf<LegacyTrendsCommandOptions>().toExtend<TrendsCommandOptions>();
    expectTypeOf<SessionCommandOptions>().toExtend<LegacySessionCommandOptions>();
    expectTypeOf<LegacySessionCommandOptions>().toExtend<SessionCommandOptions>();
    expectTypeOf<CompareCommandOptions>().toExtend<LegacyCompareCommandOptions>();
    expectTypeOf<LegacyCompareCommandOptions>().toExtend<CompareCommandOptions>();
    expectTypeOf<WrappedCommandOptions>().toExtend<LegacyWrappedCommandOptions>();
    expectTypeOf<LegacyWrappedCommandOptions>().toExtend<WrappedCommandOptions>();
    expectTypeOf<DoctorCommandOptions>().toExtend<LegacyDoctorCommandOptions>();
    expectTypeOf<LegacyDoctorCommandOptions>().toExtend<DoctorCommandOptions>();
    expectTypeOf<PruneCommandOptions>().toExtend<LegacyPruneCommandOptions>();
    expectTypeOf<LegacyPruneCommandOptions>().toExtend<PruneCommandOptions>();
  });

  it('keep disabled profile fields absent', () => {
    expectTypeOf<WrappedCommandOptions>().not.toHaveProperty('since');
    expectTypeOf<DoctorCommandOptions>().not.toHaveProperty('pricingOffline');
  });
});
