import { renderSessionReport, type SessionReportFormat } from '../render/render-session-report.js';
import { logger } from '../utils/logger.js';
import { buildSessionData } from './build-session-data.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { prepareReport, runPreparedReport } from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type {
  BuildSessionDataDeps,
  SessionCommandOptions,
  UsageDiagnostics,
} from './usage-data-contracts.js';

const sessionReportFormats = [
  'terminal',
  'markdown',
  'json',
] as const satisfies readonly SessionReportFormat[];

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

  await runPreparedReport<SessionPreparedDiagnostics, SessionReportFormat>({
    preparedReport,
    emitCommonDiagnostics: emitDiagnostics,
    getEnvVarOverrides: (diagnostics) => diagnostics.activeEnvOverrides,
    getActiveConfig: (diagnostics) => diagnostics.activeConfig,
    emitReportDiagnostics: emitSessionReportDiagnostics,
    getRuntimeProfile: (diagnostics) => diagnostics.runtimeProfile,
    warnOnTerminalOverflow: true,
  });
}
