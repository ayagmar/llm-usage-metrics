import { renderBlocksReport, type BlocksReportFormat } from '../render/render-blocks-report.js';
import { buildBlocksData } from './build-blocks-data.js';
import { hasCliFilters } from './filter-match-warnings.js';
import {
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
  validateTableDisplayFlags,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import { getDefaultWindowHint } from './run-usage-report.js';
import type { BlocksCommandOptions, BuildUsageDataDeps } from './usage-data-contracts.js';

const blocksReportFormats = STANDARD_REPORT_FORMATS satisfies readonly BlocksReportFormat[];

async function prepareBlocksReport(options: BlocksCommandOptions, deps: BuildUsageDataDeps = {}) {
  const hideCost = options.cost === false;

  return prepareReport({
    commandOptions: options,
    supportedFormats: blocksReportFormats,
    validate: () => {
      validateTableDisplayFlags(options, 'terminal and markdown tables');
    },
    buildData: () => buildBlocksData(options, deps),
    getDiagnostics: (blocksData) => blocksData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    render: (blocksData, format) =>
      renderBlocksReport(blocksData.data, format, {
        compact: options.compact,
        hideCost,
        filtered: hasCliFilters(options),
      }),
    getHintsAfterOutput: (blocksData) =>
      blocksData.defaultWindowSince
        ? getDefaultWindowHint('daily', blocksData.defaultWindowSince, {
            label: 'blocks',
            older: 'usage',
          })
        : [],
  });
}

export async function buildBlocksReport(
  options: BlocksCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<string> {
  const preparedReport = await prepareBlocksReport(options, deps);
  return preparedReport.output;
}

export async function runBlocksReport(
  options: BlocksCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareBlocksReport(options, { ...deps, runtimeProfile });

  await runStandardPreparedReport({ preparedReport });
}
