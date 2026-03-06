import type { UsageReportRow } from '../domain/usage-report-row.js';
import type { SourceAdapter } from '../sources/source-adapter.js';

import type { AdapterParseResult } from './build-usage-data-parsing.js';
import type {
  UsageDataResult,
  UsageDiagnostics,
  UsagePricingOrigin,
  UsageSourceFailure,
} from './usage-data-contracts.js';

type BuildUsageDiagnosticsParams = {
  adaptersToParse: SourceAdapter[];
  successfulParseResults: AdapterParseResult[];
  sourceFailures: UsageSourceFailure[];
  pricingOrigin: UsagePricingOrigin;
  pricingWarning?: string;
  activeEnvOverrides: UsageDiagnostics['activeEnvOverrides'];
  timezone: string;
  runtimeProfile?: UsageDiagnostics['runtimeProfile'];
};

export function buildUsageDiagnostics(params: BuildUsageDiagnosticsParams): UsageDiagnostics {
  const parseResultBySource = new Map(
    params.successfulParseResults.map((result) => [result.source.toLowerCase(), result]),
  );

  const sessionStats = params.adaptersToParse.map((adapter) => {
    const parseResult = parseResultBySource.get(adapter.id.toLowerCase());

    return {
      source: adapter.id,
      filesFound: parseResult?.filesFound ?? 0,
      eventsParsed: parseResult?.events.length ?? 0,
    };
  });

  const skippedRows = params.successfulParseResults
    .filter((result) => result.skippedRows > 0)
    .map((result) => ({
      source: result.source,
      skippedRows: result.skippedRows,
      reasons: result.skippedRowReasons,
    }));

  return {
    sessionStats,
    sourceFailures: params.sourceFailures,
    skippedRows,
    pricingOrigin: params.pricingOrigin,
    pricingWarning: params.pricingWarning,
    activeEnvOverrides: params.activeEnvOverrides,
    timezone: params.timezone,
    runtimeProfile: params.runtimeProfile,
  };
}

export function assembleUsageDataResult(
  events: UsageDataResult['events'],
  rows: UsageReportRow[],
  diagnostics: UsageDiagnostics,
): UsageDataResult {
  return {
    events,
    rows,
    diagnostics,
  };
}
