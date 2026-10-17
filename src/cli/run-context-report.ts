import { renderContextReport, type ContextReportFormat } from '../render/render-context-report.js';
import { logger } from '../utils/logger.js';
import { buildContextData } from './build-context-data.js';
import { hasCliFilters } from './filter-match-warnings.js';
import {
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import { getDefaultWindowHint } from './run-usage-report.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type {
  BuildUsageDataDeps,
  ContextCommandOptions,
  UsageDiagnostics,
} from './usage-data-contracts.js';

const contextReportFormats = STANDARD_REPORT_FORMATS satisfies readonly ContextReportFormat[];

type ContextPreparedDiagnostics = UsageDiagnostics & {
  limitNote?: string;
};

async function prepareContextReport(options: ContextCommandOptions, deps: BuildUsageDataDeps = {}) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: contextReportFormats,
    validate: () => {
      if (options.top !== undefined && !options.bySession) {
        throw new Error('--top applies with --by-session');
      }
    },
    buildData: () => buildContextData(options, deps),
    getDiagnostics: (contextData): ContextPreparedDiagnostics => ({
      ...contextData.diagnostics,
      limitNote: contextData.limitNote,
    }),
    runtimeProfile: deps.runtimeProfile,
    render: (contextData, format) =>
      renderContextReport(contextData, format, { filtered: hasCliFilters(options) }),
    getHintsAfterOutput: (contextData) =>
      contextData.defaultWindowSince
        ? getDefaultWindowHint('daily', contextData.defaultWindowSince)
        : [],
  });
}

function emitContextReportDiagnostics(diagnostics: ContextPreparedDiagnostics): void {
  if (diagnostics.limitNote) {
    logger.info(diagnostics.limitNote);
  }
}

export async function buildContextReport(
  options: ContextCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<string> {
  const preparedReport = await prepareContextReport(options, deps);
  return preparedReport.output;
}

export async function runContextReport(
  options: ContextCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareContextReport(options, { ...deps, runtimeProfile });

  await runStandardPreparedReport({
    preparedReport,
    emitReportDiagnostics: emitContextReportDiagnostics,
  });
}
