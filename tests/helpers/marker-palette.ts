import type { TerminalStylePalette } from '../../src/render/terminal-style-policy.js';

/** Wraps text in `<color>` tags, so color applies the same whether or not stdout is a TTY. */
export const markerPalette: TerminalStylePalette = {
  cyan: (text) => `<cyan>${text}</cyan>`,
  magenta: (text) => `<magenta>${text}</magenta>`,
  blue: (text) => `<blue>${text}</blue>`,
  yellow: (text) => `<yellow>${text}</yellow>`,
  green: (text) => `<green>${text}</green>`,
  red: (text) => `<red>${text}</red>`,
  white: (text) => `<white>${text}</white>`,
  bold: (text) => `<bold>${text}</bold>`,
  dim: (text) => `<dim>${text}</dim>`,
};
