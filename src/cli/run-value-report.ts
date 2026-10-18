import { renderValueReport, type ValueReportFormat } from '../render/render-value-report.js';
import { buildValueData } from './build-value-data.js';
import { hasCliFilters } from './filter-match-warnings.js';
import {
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
  validateTableDisplayFlags,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type { BuildUsageDataDeps, ValueCommandOptions } from './usage-data-contracts.js';

const valueReportFormats = STANDARD_REPORT_FORMATS satisfies readonly ValueReportFormat[];

async function prepareValueReport(options: ValueCommandOptions, deps: BuildUsageDataDeps = {}) {
  const hideCost = options.cost === false;

  return prepareReport({
    commandOptions: options,
    supportedFormats: valueReportFormats,
    validate: () => {
      validateTableDisplayFlags(options, 'tables');
    },
    buildData: () => buildValueData(options, deps),
    getDiagnostics: (valueData) => valueData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    render: (valueData, format) =>
      renderValueReport(valueData.data, format, {
        compact: options.compact,
        hideCost,
        filtered: hasCliFilters(options),
      }),
  });
}

export async function buildValueReportOutput(
  options: ValueCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<string> {
  const preparedReport = await prepareValueReport(options, deps);
  return preparedReport.output;
}

export async function runValueReport(options: ValueCommandOptions): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareValueReport(options, { runtimeProfile });

  await runStandardPreparedReport({ preparedReport });
}
