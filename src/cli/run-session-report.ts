import { renderSessionReport, type SessionReportFormat } from '../render/render-session-report.js';
import { buildSessionData } from './build-session-data.js';
import {
  emitLimitNote,
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
  type LimitedReportDiagnostics,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { BuildSessionDataDeps, SessionCommandOptions } from './usage-data-contracts.js';
import { hasCliFilters } from './filter-match-warnings.js';

const sessionReportFormats = STANDARD_REPORT_FORMATS satisfies readonly SessionReportFormat[];

async function prepareSessionReport(
  options: SessionCommandOptions,
  deps: BuildSessionDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: sessionReportFormats,
    buildData: () => buildSessionData(options, deps),
    getDiagnostics: (sessionData): LimitedReportDiagnostics => ({
      ...sessionData.diagnostics,
      limitNote: sessionData.limitNote,
    }),
    runtimeProfile: deps.runtimeProfile,
    render: (sessionData, format) =>
      renderSessionReport(sessionData, format, {
        timezone: sessionData.diagnostics.timezone,
        truncateSessionIds: !options.id?.length,
        filtered: hasCliFilters(options),
      }),
  });
}

export async function buildSessionReport(options: SessionCommandOptions): Promise<string> {
  const preparedReport = await prepareSessionReport(options);
  return preparedReport.output;
}

export async function runSessionReport(options: SessionCommandOptions): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareSessionReport(options, { runtimeProfile });

  await runStandardPreparedReport({
    preparedReport,
    emitReportDiagnostics: emitLimitNote,
  });
}
