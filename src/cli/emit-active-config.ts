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

export function emitActiveConfig(
  activeConfig: ActiveConfig | undefined,
  diagnosticsLogger: ActiveConfigLogger,
): void {
  const activeConfigLines = formatActiveConfig(activeConfig);

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

// Doctor and prune skip the report lifecycle but still owe the user the same
// `Active config:` block and unknown-key warnings the reports emit on stderr.
export function emitUserConfigResolution(
  userConfigResolution: UserConfigResolution,
  diagnosticsLogger: UserConfigLogger,
): void {
  const activeConfig = mergeActiveConfigEntries(userConfigResolution.loadedConfig, [
    ...(userConfigResolution.activeConfig?.entries ?? []),
    ...collectRuntimeConfigEntries(userConfigResolution.loadedConfig),
  ]);
  emitActiveConfig(activeConfig, diagnosticsLogger);

  for (const warning of userConfigResolution.loadedConfig.warnings) {
    diagnosticsLogger.warn(warning);
  }
}
