import pc from 'picocolors';

import { resolveTtyColumns, wrapProse } from '../render/table-text-layout.js';

type LogStyle = 'info' | 'warn' | 'dim' | 'debug';
export type LogLevel = 'silent' | 'warn' | 'info' | 'debug';

const levelRanks: Record<LogLevel, number> = {
  silent: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const icons: Record<LogStyle, string> = {
  info: pc.blue('ℹ'),
  warn: pc.yellow('⚠'),
  dim: pc.gray('•'),
  debug: pc.gray('·'),
};

let activeLevel: LogLevel = 'info';
let scrubMessage: ((message: string) => string) | undefined;

export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
}

function isEnabled(rank: number): boolean {
  return levelRanks[activeLevel] >= rank;
}

/** Runs `run` with every logged message passed through `scrub` (`--redact` hides names). */
export function withLogScrubber<T>(
  scrub: ((message: string) => string) | undefined,
  run: () => T,
): T {
  const previous = scrubMessage;
  scrubMessage = scrub;

  try {
    return run();
  } finally {
    scrubMessage = previous;
  }
}

const iconWidth = 2;
// Narrower than this, wrapping would leave a word or two per line.
const minWrapColumns = 20;

/**
 * Wraps to the width of a terminal stderr, indenting continuation lines under the text
 * after the icon; piped stderr is left as it is. Words are never split, so a path or
 * command still copies in one piece.
 */
function wrapToStderr(text: string): string {
  const columns = resolveTtyColumns(process.stderr);

  if (columns === undefined || columns < minWrapColumns) {
    return text;
  }

  return wrapProse(text, columns - iconWidth, { breakWords: false }).replaceAll(
    '\n',
    `\n${' '.repeat(iconWidth)}`,
  );
}

function formatMessage(style: LogStyle, message: string): string {
  const icon = icons[style];
  return `${icon} ${wrapToStderr(scrubMessage ? scrubMessage(message) : message)}`;
}

export const logger = {
  info: (message: string): void => {
    if (!isEnabled(levelRanks.info)) {
      return;
    }

    console.error(formatMessage('info', message));
  },
  warn: (message: string): void => {
    if (!isEnabled(levelRanks.warn)) {
      return;
    }

    console.error(formatMessage('warn', message));
  },
  dim: (message: string): void => {
    if (!isEnabled(levelRanks.info)) {
      return;
    }

    console.error(formatMessage('dim', message));
  },
  debug: (message: string): void => {
    if (!isEnabled(levelRanks.debug)) {
      return;
    }

    console.error(formatMessage('debug', message));
  },
};
