import { logger } from '../../utils/logger.js';
import type { ActiveConfig } from '../../config/active-config-display.js';
import type { EnvVarOverride } from '../../config/env-var-display.js';
import { emitActiveConfig } from '../emit-active-config.js';
import { emitDiagnostics } from '../emit-diagnostics.js';
import { emitEnvVarOverrides } from '../emit-env-var-overrides.js';
import type { UsageDiagnostics } from '../usage-data-contracts.js';
import {
  emitRuntimeProfile,
  mergeRuntimeProfiles,
  measureRuntimeProfileStage,
  measureRuntimeProfileStageSync,
  type RuntimeProfileCollector,
  type RuntimeProfileSnapshot,
} from '../runtime-profile.js';
import { writeAndOpenShareSvgFile } from '../share-artifact.js';
import { warnIfTerminalTableOverflows } from '../terminal-overflow-warning.js';

type StandardReportFormat = 'terminal' | 'markdown' | 'json';

export const STANDARD_REPORT_FORMATS = ['terminal', 'markdown', 'json'] as const;

type OutputFlagOptions = {
  json?: boolean;
  markdown?: boolean;
};

type ShareArtifact = {
  fileName: string;
  svg: string;
  logLabel: string;
};

type PreparedReport<Format extends string, Diagnostics> = {
  format: Format;
  output: string;
  diagnostics: Diagnostics;
  shareArtifact?: ShareArtifact;
  runtimeProfile?: RuntimeProfileCollector;
};

type PrepareReportOptions<Data, Diagnostics, Format extends StandardReportFormat> = {
  commandOptions: OutputFlagOptions;
  supportedFormats: readonly Format[];
  validate?: () => void;
  buildData: () => Promise<Data>;
  render: (data: Data, format: Format) => string;
  getDiagnostics: (data: Data) => Diagnostics;
  createShareArtifact?: (data: Data) => ShareArtifact | undefined;
  runtimeProfile?: RuntimeProfileCollector;
};

type RunPreparedReportOptions<Diagnostics, Format extends string> = {
  preparedReport: PreparedReport<Format, Diagnostics>;
  emitCommonDiagnostics?: (diagnostics: Diagnostics) => void;
  getEnvVarOverrides?: (diagnostics: Diagnostics) => EnvVarOverride[];
  getActiveConfig?: (diagnostics: Diagnostics) => ActiveConfig | undefined;
  emitReportDiagnostics?: (diagnostics: Diagnostics) => void;
  getRuntimeProfile?: (diagnostics: Diagnostics) => RuntimeProfileSnapshot | undefined;
  warnOnTerminalOverflow?: boolean;
};

function validateOutputFormatOptions(options: OutputFlagOptions): void {
  if (options.markdown && options.json) {
    throw new Error('Choose either --markdown or --json, not both');
  }
}

function resolveReportFormat<Format extends StandardReportFormat>(
  options: OutputFlagOptions,
  supportedFormats: readonly Format[],
): Format {
  const requestedFormat: StandardReportFormat = options.json
    ? 'json'
    : options.markdown
      ? 'markdown'
      : 'terminal';

  const resolvedFormat = supportedFormats.find((format) => format === requestedFormat);

  if (resolvedFormat) {
    return resolvedFormat;
  }

  throw new Error(`--${requestedFormat} is not supported for this command`);
}

export async function prepareReport<Data, Diagnostics, Format extends StandardReportFormat>(
  options: PrepareReportOptions<Data, Diagnostics, Format>,
): Promise<PreparedReport<Format, Diagnostics>> {
  validateOutputFormatOptions(options.commandOptions);
  options.validate?.();
  const format = resolveReportFormat(options.commandOptions, options.supportedFormats);

  const data = await measureRuntimeProfileStage(
    options.runtimeProfile,
    'report.prepare.build_data',
    options.buildData,
  );
  const output = measureRuntimeProfileStageSync(
    options.runtimeProfile,
    'report.prepare.render',
    () => options.render(data, format),
  );

  return {
    format,
    diagnostics: options.getDiagnostics(data),
    output,
    shareArtifact: options.createShareArtifact?.(data),
    runtimeProfile: options.runtimeProfile,
  };
}

async function writeShareArtifact(artifact: ShareArtifact): Promise<void> {
  const shareResult = await writeAndOpenShareSvgFile(artifact.fileName, artifact.svg);
  logger.info(`Wrote ${artifact.logLabel} share SVG: ${shareResult.outputPath}`);

  if (shareResult.opened) {
    logger.info(`Opened ${artifact.logLabel} share SVG: ${shareResult.outputPath}`);
    return;
  }

  logger.warn(
    `Could not open ${artifact.logLabel} share SVG: ${shareResult.outputPath} (${shareResult.openErrorMessage})`,
  );
}

type EmitReportRunDiagnosticsOptions<Diagnostics> = {
  emitCommonDiagnostics?: (diagnostics: Diagnostics) => void;
  getEnvVarOverrides?: (diagnostics: Diagnostics) => EnvVarOverride[];
  getActiveConfig?: (diagnostics: Diagnostics) => ActiveConfig | undefined;
  emitReportDiagnostics?: (diagnostics: Diagnostics) => void;
  getRuntimeProfile?: (diagnostics: Diagnostics) => RuntimeProfileSnapshot | undefined;
  runtimeProfile?: RuntimeProfileCollector;
};

// The one place that fixes the stderr diagnostics ordering shared by every
// report command, including the streaming events export.
export function emitReportRunDiagnostics<Diagnostics>(
  diagnostics: Diagnostics,
  options: EmitReportRunDiagnosticsOptions<Diagnostics>,
): void {
  options.emitCommonDiagnostics?.(diagnostics);
  emitEnvVarOverrides(options.getEnvVarOverrides?.(diagnostics) ?? [], logger);
  emitActiveConfig(options.getActiveConfig?.(diagnostics), logger);
  options.emitReportDiagnostics?.(diagnostics);
  emitRuntimeProfile(
    mergeRuntimeProfiles(
      options.runtimeProfile?.snapshot(),
      options.getRuntimeProfile?.(diagnostics),
    ),
    logger,
  );
}

export async function runPreparedReport<Diagnostics, Format extends string>(
  options: RunPreparedReportOptions<Diagnostics, Format>,
): Promise<void> {
  emitReportRunDiagnostics(options.preparedReport.diagnostics, {
    emitCommonDiagnostics: options.emitCommonDiagnostics,
    getEnvVarOverrides: options.getEnvVarOverrides,
    getActiveConfig: options.getActiveConfig,
    emitReportDiagnostics: options.emitReportDiagnostics,
    getRuntimeProfile: options.getRuntimeProfile,
    runtimeProfile: options.preparedReport.runtimeProfile,
  });

  if (options.warnOnTerminalOverflow && options.preparedReport.format === 'terminal') {
    warnIfTerminalTableOverflows(options.preparedReport.output, (message) => {
      logger.warn(message);
    });
  }

  if (options.preparedReport.shareArtifact) {
    await writeShareArtifact(options.preparedReport.shareArtifact);
  }

  console.log(options.preparedReport.output);
}

type RunStandardPreparedReportOptions<Diagnostics, Format extends string> = {
  preparedReport: PreparedReport<Format, Diagnostics>;
  emitReportDiagnostics?: (diagnostics: Diagnostics) => void;
  warnOnTerminalOverflow?: boolean;
};

// Standard wiring for diagnostics that extend UsageDiagnostics; bespoke
// runPreparedReport calls in report wrappers are a review smell.
export async function runStandardPreparedReport<
  Diagnostics extends UsageDiagnostics,
  Format extends string,
>(options: RunStandardPreparedReportOptions<Diagnostics, Format>): Promise<void> {
  await runPreparedReport({
    preparedReport: options.preparedReport,
    emitCommonDiagnostics: emitDiagnostics,
    getEnvVarOverrides: (diagnostics) => diagnostics.activeEnvOverrides,
    getActiveConfig: (diagnostics) => diagnostics.activeConfig,
    emitReportDiagnostics: options.emitReportDiagnostics,
    getRuntimeProfile: (diagnostics) => diagnostics.runtimeProfile,
    warnOnTerminalOverflow: options.warnOnTerminalOverflow ?? true,
  });
}
