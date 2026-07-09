import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger, setLogLevel, type LogLevel } from '../../src/utils/logger.js';

afterEach(() => {
  setLogLevel('info');
  vi.restoreAllMocks();
});

function spyOnStderr() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function logAllLevels(): void {
  logger.warn('warn message');
  logger.info('info message');
  logger.dim('dim message');
  logger.debug('debug message');
}

function collectMessages(errorSpy: ReturnType<typeof spyOnStderr>): string[] {
  return errorSpy.mock.calls.map((call) => String(call[0]));
}

describe('logger', () => {
  it('writes info, warn, and dim messages by default', () => {
    const errorSpy = spyOnStderr();

    logger.info('info message');
    logger.warn('warn message');
    logger.dim('dim message');
    logger.debug('debug message');

    expect(errorSpy).toHaveBeenCalledTimes(3);

    const messages = collectMessages(errorSpy);
    expect(messages[0]).toContain('info message');
    expect(messages[1]).toContain('warn message');
    expect(messages[2]).toContain('dim message');
    expect(messages.join('\n')).not.toContain('debug message');
  });

  it.each([
    { level: 'silent', messages: [] },
    { level: 'warn', messages: ['warn message'] },
    { level: 'info', messages: ['warn message', 'info message', 'dim message'] },
    {
      level: 'debug',
      messages: ['warn message', 'info message', 'dim message', 'debug message'],
    },
  ] satisfies Array<{ level: LogLevel; messages: string[] }>)(
    'emits the expected methods at $level level',
    ({ level, messages }) => {
      const errorSpy = spyOnStderr();

      setLogLevel(level);
      logAllLevels();

      expect(collectMessages(errorSpy).map((message) => message.replace(/^. /u, ''))).toEqual(
        messages,
      );
    },
  );

  it('switches levels at runtime', () => {
    const errorSpy = spyOnStderr();

    setLogLevel('warn');
    logger.info('hidden info');
    logger.warn('visible warn');

    setLogLevel('debug');
    logger.debug('visible debug');

    expect(collectMessages(errorSpy).map((message) => message.replace(/^. /u, ''))).toEqual([
      'visible warn',
      'visible debug',
    ]);
  });
});
