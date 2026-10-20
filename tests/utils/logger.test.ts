import { afterEach, describe, expect, it, vi } from 'vitest';

import { visibleWidth } from '../../src/render/table-text-layout.js';
import { logger, setLogLevel, type LogLevel } from '../../src/utils/logger.js';

const stderrTty = {
  isTTY: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY'),
  columns: Object.getOwnPropertyDescriptor(process.stderr, 'columns'),
};

function setStderr(isTTY: boolean, columns: number): void {
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: isTTY });
  Object.defineProperty(process.stderr, 'columns', { configurable: true, value: columns });
}

afterEach(() => {
  setLogLevel('info');
  vi.restoreAllMocks();

  for (const [key, descriptor] of Object.entries(stderrTty)) {
    if (descriptor) {
      Object.defineProperty(process.stderr, key, descriptor);
    } else {
      Reflect.deleteProperty(process.stderr, key);
    }
  }
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

const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');

function collectMessages(errorSpy: ReturnType<typeof spyOnStderr>): string[] {
  return errorSpy.mock.calls.map((call) => String(call[0]).replaceAll(ansiPattern, ''));
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

  const longNote =
    'Fitted the table to the terminal: abbreviated token counts, hid Input and Output. Widen the terminal or use --json for full detail.';

  it('wraps a long message to a narrow terminal stderr, indented under the icon', () => {
    const errorSpy = spyOnStderr();
    setStderr(true, 44);

    logger.info(longNote);

    const lines = collectMessages(errorSpy)[0]?.split('\n') ?? [];
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith('  ') && line[2] !== ' ')).toBe(true);
    expect(lines.map((line) => line.trim()).join(' ')).toBe(`ℹ ${longNote}`);
  });

  it('leaves the message on one line when stderr is piped, whatever its width', () => {
    const errorSpy = spyOnStderr();
    setStderr(false, 44);

    logger.warn(longNote);

    expect(collectMessages(errorSpy)).toEqual([`⚠ ${longNote}`]);
  });
});
