import { renderSessionReport, type SessionReportFormat } from '../render/render-session-report.js';
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

async function prepareSessionReport(
  options: SessionCommandOptions,
  deps: BuildSessionDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: sessionReportFormats,
    buildData: () => buildSessionData(options, deps),
    getDiagnostics: (sessionData) => sessionData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    render: (sessionData, format) =>
      renderSessionReport(sessionData, format, {
        timezone: sessionData.diagnostics.timezone,
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

  await runPreparedReport<UsageDiagnostics, SessionReportFormat>({
    preparedReport,
    emitCommonDiagnostics: emitDiagnostics,
    getEnvVarOverrides: (diagnostics) => diagnostics.activeEnvOverrides,
    getRuntimeProfile: (diagnostics) => diagnostics.runtimeProfile,
    warnOnTerminalOverflow: true,
  });
}
