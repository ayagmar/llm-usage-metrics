import {
  buildUsageData,
  DEFAULT_REPORT_WINDOWS,
  HOURLY_MAX_LAST_DAYS,
  resolveUsageDataRequest,
} from './build-usage-data.js';
import {
  prepareReport,
  runStandardPreparedReport,
  STANDARD_REPORT_FORMATS,
} from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type {
  BuildUsageDataDeps,
  ReportCommandOptions,
  UsageDataResult,
} from './usage-data-contracts.js';
import {
  renderUsageReportWithNotes,
  type UsageReportFormat,
} from '../render/render-usage-report.js';
import type { UsageTableLayout } from '../render/row-cells.js';
import type { ReportGranularity, UsageGranularity } from '../utils/time-buckets.js';
import { hasCliFilters } from './filter-match-warnings.js';
import {
  buildShareReportArtifact,
  toShareDateRange,
  toShareGranularity,
} from './share-report-artifact.js';

const usageReportFormats = STANDARD_REPORT_FORMATS satisfies readonly UsageReportFormat[];

function resolveTableLayout(options: ReportCommandOptions): UsageTableLayout {
  return options.perModelColumns ? 'per_model_columns' : 'compact';
}

/**
 * The hint after a report that covered its default window. `subject` names what a
 * non-usage report shows (`blocks`, `tool calls`) and what is older (`usage`, `calls`).
 */
export function getDefaultWindowHint(
  granularity: UsageGranularity,
  since: string,
  subject?: { label: string; older: string },
): string[] {
  if (granularity === 'hourly') {
    return [
      `Showing today (${since}) hour by hour. Use --last N (up to ${String(HOURLY_MAX_LAST_DAYS)} days) or --since YYYY-MM-DD for earlier hours.`,
    ];
  }

  const defaultWindow = DEFAULT_REPORT_WINDOWS[granularity];

  if (!defaultWindow) {
    return [];
  }

  return [
    `Showing ${subject ? `${subject.label} of ` : ''}the last ${String(defaultWindow.periods)} ${defaultWindow.period}s (since ${since}). Use --since YYYY-MM-DD or --all for older ${subject?.older ?? 'usage'}.`,
  ];
}

function resolveShareFileBaseName(granularity: ReportGranularity): string {
  return `usage-${granularity}-share`;
}

function getRepeatedHourNotes(usageData: UsageDataResult): string[] {
  const repeatedKeys = new Set(
    usageData.rows
      .filter((row) => row.rowType !== 'grand_total' && row.repeatedHour === true)
      .map((row) => row.periodKey),
  );

  return [...repeatedKeys].map(
    (key) =>
      `${key} repeats: the clocks went back at the end of daylight saving time, so its row covers both occurrences.`,
  );
}

function getHintsAfterOutput(granularity: UsageGranularity, usageData: UsageDataResult): string[] {
  return [
    ...(granularity === 'hourly' ? getRepeatedHourNotes(usageData) : []),
    ...(usageData.defaultWindowSince
      ? getDefaultWindowHint(granularity, usageData.defaultWindowSince)
      : []),
  ];
}

async function prepareUsageReport(
  granularity: UsageGranularity,
  options: ReportCommandOptions,
  deps: BuildUsageDataDeps = {},
) {
  const tableLayout = resolveTableLayout(options);
  const hideCost = options.cost === false;

  return prepareReport({
    commandOptions: options,
    supportedFormats: usageReportFormats,
    buildData: () => buildUsageData(granularity, options, deps),
    getDiagnostics: (usageData) => usageData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    // hourly has no --share.
    buildShare:
      granularity === 'hourly'
        ? undefined
        : async (_usageData, { runtimeProfile }) => {
            const { options: windowOptions } = await resolveUsageDataRequest(
              granularity,
              options,
              deps,
            );
            const window = toShareDateRange(windowOptions.since, windowOptions.until);

            return buildShareReportArtifact(
              {
                command: granularity,
                options,
                window,
                initialView: { ...window, granularity: toShareGranularity(granularity) },
                fileBaseName: resolveShareFileBaseName(granularity),
                logLabel: 'usage',
              },
              { ...deps, runtimeProfile },
            );
          },
    validate: () => {
      if (options.compact && options.json) {
        throw new Error('--compact applies to terminal and markdown tables; drop it with --json');
      }

      if (hideCost && options.json) {
        throw new Error('--no-cost applies to tables and the share report; drop it with --json');
      }
    },
    render: (usageData, format) => {
      const { output, notes } = renderUsageReportWithNotes(usageData, format, {
        granularity,
        tableLayout,
        compact: options.compact,
        hideCost,
        filtered: hasCliFilters(options),
      });

      return { output, hintsAfterOutput: notes };
    },
    getHintsAfterOutput: (usageData) => getHintsAfterOutput(granularity, usageData),
  });
}

export async function buildUsageReport(
  granularity: UsageGranularity,
  options: ReportCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<string> {
  const preparedReport = await prepareUsageReport(granularity, options, deps);
  return preparedReport.output;
}

export async function runUsageReport(
  granularity: UsageGranularity,
  options: ReportCommandOptions,
): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareUsageReport(granularity, options, { runtimeProfile });

  await runStandardPreparedReport({ preparedReport });
}
