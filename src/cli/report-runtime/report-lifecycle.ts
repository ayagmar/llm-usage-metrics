import { logger } from '../../utils/logger.js';
import type { EnvVarOverride } from '../../config/env-var-display.js';
import { emitEnvVarOverrides } from '../emit-env-var-overrides.js';
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

export async function runPreparedReport<Diagnostics, Format extends string>(
  options: RunPreparedReportOptions<Diagnostics, Format>,
): Promise<void> {
  options.emitCommonDiagnostics?.(options.preparedReport.diagnostics);

  const envVarOverrides = options.getEnvVarOverrides?.(options.preparedReport.diagnostics) ?? [];
  emitEnvVarOverrides(envVarOverrides, logger);
  options.emitReportDiagnostics?.(options.preparedReport.diagnostics);
  emitRuntimeProfile(
    mergeRuntimeProfiles(
      options.preparedReport.runtimeProfile?.snapshot(),
      options.getRuntimeProfile?.(options.preparedReport.diagnostics),
    ),
    logger,
  );

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
