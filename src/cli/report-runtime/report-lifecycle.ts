import { logger, withLogScrubber } from '../../utils/logger.js';
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
import { openShareFile, writeShareFile, type ShareArtifact } from '../share-artifact.js';
import { warnIfTerminalTableOverflows } from '../terminal-overflow-warning.js';

type StandardReportFormat = 'terminal' | 'markdown' | 'json';

export const STANDARD_REPORT_FORMATS = ['terminal', 'markdown', 'json'] as const;

const verboseLogger = { info: logger.debug, dim: logger.debug };

type OutputFlagOptions = {
  json?: boolean;
  markdown?: boolean;
  share?: boolean;
  /** Commander sets it to false for --no-open. */
  open?: boolean;
  redact?: boolean;
};

/** What a share builder gets besides the report data. */
export type ShareBuildContext = {
  runtimeProfile?: RuntimeProfileCollector;
};

type PreparedReport<Format extends string, Diagnostics> = {
  format: Format;
  output: string;
  diagnostics: Diagnostics;
  shareArtifact?: ShareArtifact;
  /** False with --no-open: the share report is written but not opened. */
  openShareArtifact?: boolean;
  runtimeProfile?: RuntimeProfileCollector;
  /** Informational stderr lines printed after the report, so they read as its footer. */
  hintsAfterOutput?: readonly string[];
};

/** A render can return stderr hints about the output, such as columns a narrow terminal hid. */
type RenderedOutput = string | { output: string; hintsAfterOutput: readonly string[] };

type PrepareReportOptions<Data, Diagnostics, Format extends StandardReportFormat> = {
  commandOptions: OutputFlagOptions;
  supportedFormats: readonly Format[];
  validate?: () => void;
  buildData: () => Promise<Data>;
  render: (data: Data, format: Format) => RenderedOutput;
  getDiagnostics: (data: Data) => Diagnostics;
  /** Runs only with --share, after buildData and in its own profiled stage. */
  buildShare?: (data: Data, context: ShareBuildContext) => Promise<ShareArtifact>;
  getHintsAfterOutput?: (data: Data, format: Format) => readonly string[];
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

  if (options.open === false && !options.share) {
    throw new Error('--no-open only applies with --share');
  }

  if (options.redact && !options.share) {
    throw new Error('--redact only applies with --share');
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
  const buildShare = options.commandOptions.share ? options.buildShare : undefined;
  const shareArtifact = buildShare
    ? await measureRuntimeProfileStage(options.runtimeProfile, 'report.prepare.build_share', () =>
        buildShare(data, { runtimeProfile: options.runtimeProfile }),
      )
    : undefined;
  const rendered = measureRuntimeProfileStageSync(
    options.runtimeProfile,
    'report.prepare.render',
    () => options.render(data, format),
  );
  const { output, hintsAfterOutput: renderHints } =
    typeof rendered === 'string' ? { output: rendered, hintsAfterOutput: [] } : rendered;
  const dataHints = options.getHintsAfterOutput?.(data, format) ?? [];
  const hintsAfterOutput = [...renderHints, ...dataHints];

  return {
    format,
    diagnostics: options.getDiagnostics(data),
    output,
    shareArtifact,
    openShareArtifact: options.commandOptions.open !== false,
    runtimeProfile: options.runtimeProfile,
    hintsAfterOutput: hintsAfterOutput.length > 0 ? hintsAfterOutput : undefined,
  };
}

// Writes the HTML report and opens it unless --no-open; an open failure only warns.
async function writeShareArtifact(artifact: ShareArtifact, open: boolean): Promise<void> {
  const reportPath = await writeShareFile(artifact.fileName, artifact.render());
  logger.info(`Wrote ${artifact.logLabel} share report: ${reportPath}`);

  if (!open) {
    return;
  }

  try {
    await openShareFile(reportPath);
    logger.info(`Opened ${artifact.logLabel} share report: ${reportPath}`);
  } catch (error) {
    logger.warn(
      `Could not open ${artifact.logLabel} share report: ${reportPath} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

type EmitReportRunDiagnosticsOptions<Diagnostics> = {
  emitCommonDiagnostics?: (diagnostics: Diagnostics) => void;
  getEnvVarOverrides?: (diagnostics: Diagnostics) => EnvVarOverride[];
  getActiveConfig?: (diagnostics: Diagnostics) => ActiveConfig | undefined;
  emitReportDiagnostics?: (diagnostics: Diagnostics) => void;
  getRuntimeProfile?: (diagnostics: Diagnostics) => RuntimeProfileSnapshot | undefined;
  runtimeProfile?: RuntimeProfileCollector;
};

/**
 * `--compact` and `--no-cost` change tables only, so `--json` rejects them. `costAppliesTo`
 * says what `--no-cost` changes in this report.
 */
export function validateTableDisplayFlags(
  options: { compact?: boolean; cost?: boolean; json?: boolean },
  costAppliesTo: string,
): void {
  if (options.compact && options.json) {
    throw new Error('--compact applies to terminal and markdown tables; drop it with --json');
  }

  if (options.cost === false && options.json) {
    throw new Error(`--no-cost applies to ${costAppliesTo}; drop it with --json`);
  }
}

/** Diagnostics of a report whose --top can leave rows out. */
export type LimitedReportDiagnostics = UsageDiagnostics & { limitNote?: string };

/** Prints the note naming the rows --top left out, if any. */
export function emitLimitNote(diagnostics: { limitNote?: string }): void {
  if (diagnostics.limitNote) {
    logger.info(diagnostics.limitNote);
  }
}

// The one place that fixes the stderr diagnostics ordering shared by every
// report command, including the streaming events export.
export function emitReportRunDiagnostics<Diagnostics>(
  diagnostics: Diagnostics,
  options: EmitReportRunDiagnosticsOptions<Diagnostics>,
): void {
  options.emitCommonDiagnostics?.(diagnostics);
  // The summary line already counts env overrides and names the config file; the
  // full blocks are `--verbose` detail.
  emitEnvVarOverrides(options.getEnvVarOverrides?.(diagnostics) ?? [], verboseLogger);
  emitActiveConfig(options.getActiveConfig?.(diagnostics), verboseLogger);
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
  // With --redact, stderr hides what the file hides; only the path of the file written shows.
  const scrubLog = options.preparedReport.shareArtifact?.scrubLog;

  withLogScrubber(scrubLog, () => {
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
  });

  if (options.preparedReport.shareArtifact) {
    await writeShareArtifact(
      options.preparedReport.shareArtifact,
      options.preparedReport.openShareArtifact ?? true,
    );
  }

  console.log(options.preparedReport.output);

  withLogScrubber(scrubLog, () => {
    for (const hint of options.preparedReport.hintsAfterOutput ?? []) {
      logger.info(hint);
    }
  });
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
