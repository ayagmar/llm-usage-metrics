import { renderBlocksReport, type BlocksReportFormat } from '../render/render-blocks-report.js';
import { buildBlocksData } from './build-blocks-data.js';
import { BLOCKS_DEFAULT_LAST_DAYS } from './report-definitions/report-definitions.js';
import { hasCliFilters } from './filter-match-warnings.js';
import {
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { BlocksCommandOptions, BuildUsageDataDeps } from './usage-data-contracts.js';

const blocksReportFormats = STANDARD_REPORT_FORMATS satisfies readonly BlocksReportFormat[];

async function prepareBlocksReport(options: BlocksCommandOptions, deps: BuildUsageDataDeps = {}) {
  const hideCost = options.cost === false;

  return prepareReport({
    commandOptions: options,
    supportedFormats: blocksReportFormats,
    validate: () => {
      if (options.compact && options.json) {
        throw new Error('--compact applies to terminal and markdown tables; drop it with --json');
      }

      if (hideCost && options.json) {
        throw new Error('--no-cost applies to terminal and markdown tables; drop it with --json');
      }
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
        ? [
            `Showing blocks of the last ${String(BLOCKS_DEFAULT_LAST_DAYS)} days (since ${blocksData.defaultWindowSince}). Use --since YYYY-MM-DD or --all for older usage.`,
          ]
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
