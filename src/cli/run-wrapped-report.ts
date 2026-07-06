import { renderWrappedShareSvg } from '../render/render-wrapped-share-svg.js';
import { formatApproxUsd, formatInteger } from '../render/share-svg-theme.js';
import type { WrappedRecap, WrappedTopItem } from '../wrapped/wrapped-recap.js';
import { buildWrappedData, parseWrappedYearOption } from './build-wrapped-data.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { prepareReport, runPreparedReport } from './report-runtime/report-lifecycle.js';
import { createRuntimeProfileCollector } from './runtime-profile.js';
import type {
  BuildWrappedDataDeps,
  UsageDiagnostics,
  WrappedCommandOptions,
} from './usage-data-contracts.js';

type WrappedReportFormat = 'terminal' | 'json';

const wrappedReportFormats = ['terminal', 'json'] as const satisfies readonly WrappedReportFormat[];

function formatTopItems(items: readonly WrappedTopItem[]): string[] {
  if (items.length === 0) {
    return ['  -'];
  }

  return items.map(
    (item, index) =>
      `  ${index + 1}. ${item.name} - ${formatInteger(item.totalTokens)} tokens, ${formatApproxUsd(item.costUsd, item.costIncomplete)}`,
  );
}

function renderWrappedTerminalReport(data: WrappedRecap): string {
  return [
    `Wrapped ${data.year}`,
    `${data.from} to ${data.to} (${data.timezone})`,
    '',
    `Tokens: ${formatInteger(data.totalTokens)}`,
    `Cost: ${formatApproxUsd(data.totalCostUsd, data.costIncomplete)}`,
    `Active days: ${formatInteger(data.activeDays)}`,
    `Longest streak: ${formatInteger(data.longestStreak)} day(s)`,
    `Events: ${formatInteger(data.eventCount)}`,
    `Sessions: ${formatInteger(data.sessionCount)}`,
    '',
    'Top models:',
    ...formatTopItems(data.topModels),
    '',
    'Top sources:',
    ...formatTopItems(data.topSources),
  ].join('\n');
}

function renderWrappedReport(data: WrappedRecap, format: WrappedReportFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(data, null, 2);
    case 'terminal':
      return renderWrappedTerminalReport(data);
  }
}

async function prepareWrappedReport(
  options: WrappedCommandOptions,
  deps: BuildWrappedDataDeps = {},
) {
  return prepareReport({
    commandOptions: options,
    supportedFormats: wrappedReportFormats,
    validate: () => {
      parseWrappedYearOption(options.year);
    },
    buildData: () => buildWrappedData(options, deps),
    getDiagnostics: (wrappedData) => wrappedData.diagnostics,
    runtimeProfile: deps.runtimeProfile,
    createShareArtifact: options.share
      ? (wrappedData) => ({
          fileName: `llm-usage-wrapped-${wrappedData.recap.year}.svg`,
          svg: renderWrappedShareSvg(wrappedData.recap),
          logLabel: 'wrapped',
        })
      : undefined,
    render: (wrappedData, format) => renderWrappedReport(wrappedData.recap, format),
  });
}

export async function buildWrappedReport(options: WrappedCommandOptions): Promise<string> {
  const preparedReport = await prepareWrappedReport(options);
  return preparedReport.output;
}

export async function runWrappedReport(options: WrappedCommandOptions): Promise<void> {
  const runtimeProfile = createRuntimeProfileCollector();
  const preparedReport = await prepareWrappedReport(options, { runtimeProfile });

  await runPreparedReport<UsageDiagnostics, WrappedReportFormat>({
    preparedReport,
    emitCommonDiagnostics: emitDiagnostics,
    getEnvVarOverrides: (diagnostics) => diagnostics.activeEnvOverrides,
    getRuntimeProfile: (diagnostics) => diagnostics.runtimeProfile,
  });
}
