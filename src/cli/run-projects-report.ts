import {
  renderProjectsReport,
  type ProjectsReportFormat,
} from '../render/render-projects-report.js';
import { buildProjectsData } from './build-projects-data.js';
import { hasCliFilters } from './filter-match-warnings.js';
import {
  emitLimitNote,
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
  type LimitedReportDiagnostics,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { BuildUsageDataDeps, ProjectsCommandOptions } from './usage-data-contracts.js';

const projectsReportFormats = STANDARD_REPORT_FORMATS satisfies readonly ProjectsReportFormat[];

async function prepareProjectsReport(
  options: ProjectsCommandOptions,
  deps: BuildUsageDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: projectsReportFormats,
    validate: () => {
      if (options.compact && options.json) {
        throw new Error('--compact applies to terminal and markdown tables; drop it with --json');
      }

      if (options.cost === false && options.json) {
        throw new Error('--no-cost applies to tables; drop it with --json');
      }
    },
    buildData: () => buildProjectsData(options, deps),
    getDiagnostics: (projectsData): LimitedReportDiagnostics => ({
      ...projectsData.diagnostics,
      limitNote: projectsData.limitNote,
    }),
    runtimeProfile: deps.runtimeProfile,
    render: (projectsData, format) =>
      renderProjectsReport(projectsData, format, {
        compact: options.compact,
        hideCost: options.cost === false,
        filtered: hasCliFilters(options),
      }),
  });
}

export async function buildProjectsReport(
  options: ProjectsCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<string> {
  const preparedReport = await prepareProjectsReport(options, deps);
  return preparedReport.output;
}

export async function runProjectsReport(options: ProjectsCommandOptions): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareProjectsReport(options, { runtimeProfile });

  await runStandardPreparedReport({
    preparedReport,
    emitReportDiagnostics: emitLimitNote,
  });
}
