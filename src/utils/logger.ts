import pc from 'picocolors';

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

function formatMessage(style: LogStyle, message: string): string {
  const icon = icons[style];
  return `${icon} ${scrubMessage ? scrubMessage(message) : message}`;
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
