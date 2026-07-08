import { formatActiveConfig, type ActiveConfig } from '../config/active-config-display.js';

type ActiveConfigLogger = {
  info: (message: string) => void;
  dim: (message: string) => void;
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
