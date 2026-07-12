import { renderSessionReport, type SessionReportFormat } from '../render/render-session-report.js';
import { logger } from '../utils/logger.js';
import { buildSessionData } from './build-session-data.js';
import {
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type {
  BuildSessionDataDeps,
  SessionCommandOptions,
  UsageDiagnostics,
} from './usage-data-contracts.js';

const sessionReportFormats = STANDARD_REPORT_FORMATS satisfies readonly SessionReportFormat[];

type SessionPreparedDiagnostics = UsageDiagnostics & {
  limitNote?: string;
};

async function prepareSessionReport(
  options: SessionCommandOptions,
  deps: BuildSessionDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: sessionReportFormats,
    buildData: () => buildSessionData(options, deps),
    getDiagnostics: (sessionData): SessionPreparedDiagnostics => ({
      ...sessionData.diagnostics,
      limitNote: sessionData.limitNote,
    }),
    runtimeProfile: deps.runtimeProfile,
    render: (sessionData, format) =>
      renderSessionReport(sessionData, format, {
        timezone: sessionData.diagnostics.timezone,
        truncateSessionIds: !options.id?.length,
      }),
  });
}

function emitSessionReportDiagnostics(diagnostics: SessionPreparedDiagnostics): void {
  if (diagnostics.limitNote) {
    logger.info(diagnostics.limitNote);
  }
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
    emitReportDiagnostics: emitSessionReportDiagnostics,
  });
}
