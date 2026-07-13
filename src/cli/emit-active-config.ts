import { formatActiveConfig, type ActiveConfig } from '../config/active-config-display.js';
import {
  collectRuntimeConfigEntries,
  mergeActiveConfigEntries,
  type UserConfigResolution,
} from './apply-user-config.js';

type ActiveConfigLogger = {
  info: (message: string) => void;
  dim: (message: string) => void;
};

type UserConfigLogger = ActiveConfigLogger & {
  warn: (message: string) => void;
};

function emitActiveConfigLines(
  activeConfigLines: string[],
  diagnosticsLogger: ActiveConfigLogger,
): void {
  if (activeConfigLines.length === 0) {
    return;
  }

  const [headerLine, ...configLines] = activeConfigLines;

  if (headerLine) {
    diagnosticsLogger.info(headerLine);
  }

  for (const configLine of configLines) {
    diagnosticsLogger.dim(configLine);
  }
}

export function emitActiveConfig(
  activeConfig: ActiveConfig | undefined,
  diagnosticsLogger: ActiveConfigLogger,
): void {
  emitActiveConfigLines(formatActiveConfig(activeConfig), diagnosticsLogger);
}

// The provenance block shared by report diagnostics and `config show`.
export function buildActiveConfigLines(userConfigResolution: UserConfigResolution): string[] {
  const activeConfig = mergeActiveConfigEntries(userConfigResolution.loadedConfig, [
    ...(userConfigResolution.activeConfig?.entries ?? []),
    ...collectRuntimeConfigEntries(userConfigResolution.loadedConfig),
  ]);
  return formatActiveConfig(activeConfig);
}

// Doctor and prune skip the report lifecycle but still owe the user the same
// `Active config:` block and unknown-key warnings the reports emit on stderr.
export function emitUserConfigResolution(
  userConfigResolution: UserConfigResolution,
  diagnosticsLogger: UserConfigLogger,
): void {
  emitActiveConfigLines(buildActiveConfigLines(userConfigResolution), diagnosticsLogger);

  for (const warning of userConfigResolution.loadedConfig.warnings) {
    diagnosticsLogger.warn(warning);
  }
}
