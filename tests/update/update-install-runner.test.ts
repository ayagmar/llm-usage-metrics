import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  defaultConfirmInstall,
  defaultNotify,
  isInteractiveSession,
  runInteractiveInstallAndRestart,
  runCommandWithSpawn,
  type CommandRunner,
} from '../../src/update/update-install-runner.js';

// Hoisted mock fns so the hoisted vi.mock factory can reference them safely.
const { question, close } = vi.hoisted(() => ({
  question: vi.fn(),
  close: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question, close })),
}));

afterEach(() => {
  question.mockReset();
  close.mockReset();
  vi.restoreAllMocks();
});

describe('update-install-runner', () => {
  it('detects interactive sessions only when both TTYs are present and CI is not truthy', () => {
    const falseLikeCiValues = ['0', 'false', 'no', 'off', 'FALSE', '  FALSE  '];

    expect(isInteractiveSession({ env: {}, stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
    expect(isInteractiveSession({ env: { CI: '1' }, stdinIsTTY: true, stdoutIsTTY: true })).toBe(
      false,
    );
    for (const ciValue of falseLikeCiValues) {
      expect(
        isInteractiveSession({ env: { CI: ciValue }, stdinIsTTY: true, stdoutIsTTY: true }),
      ).toBe(true);
    }
    expect(isInteractiveSession({ env: {}, stdinIsTTY: false, stdoutIsTTY: true })).toBe(false);
    expect(isInteractiveSession({ env: {}, stdinIsTTY: true, stdoutIsTTY: false })).toBe(false);
  });

  it('normalizes default confirm answers and always closes the readline interface', async () => {
    question.mockResolvedValue(' YeS ');

    await expect(defaultConfirmInstall('Install now? ')).resolves.toBe(true);
    expect(question).toHaveBeenCalledWith('Install now? ');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the readline interface when default confirm rejects', async () => {
    question.mockRejectedValue(new Error('read failed'));

    await expect(defaultConfirmInstall('Install now? ')).rejects.toThrow('read failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('spawns commands and propagates spawn errors', async () => {
    await expect(runCommandWithSpawn(process.execPath, ['-e', 'process.exit(0)'])).resolves.toBe(0);

    await expect(
      runCommandWithSpawn('__llm_usage_metrics_missing_command__', []),
    ).rejects.toBeInstanceOf(Error);
  });

  it('uses default notify when install fails and no custom notifier is provided', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await runInteractiveInstallAndRestart({
      packageName: 'llm-usage-metrics',
      updateMessage: 'Update available.',
      env: {},
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily'],
      skipUpdateCheckEnvVar: 'LLM_USAGE_SKIP_UPDATE_CHECK',
      confirmInstall: vi.fn(async () => true),
      runCommand: vi.fn<CommandRunner>().mockResolvedValueOnce(5),
    });

    expect(result).toEqual({ continueExecution: true });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to install llm-usage-metrics@latest (exit code 5).',
    );
  });

  it('stops when the user declines install', async () => {
    const confirmInstall = vi.fn(async () => false);
    const runCommand = vi.fn<CommandRunner>();

    const result = await runInteractiveInstallAndRestart({
      packageName: 'llm-usage-metrics',
      updateMessage: 'Update available.',
      env: {},
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily'],
      skipUpdateCheckEnvVar: 'LLM_USAGE_SKIP_UPDATE_CHECK',
      confirmInstall,
      runCommand,
    });

    expect(result).toEqual({ continueExecution: true });
    expect(confirmInstall).toHaveBeenCalledWith('Update available. Install now? [y/N] ');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('installs latest and restarts with the skip-update env flag', async () => {
    const commandCalls: Array<{
      command: string;
      args: string[];
      options?: { env?: NodeJS.ProcessEnv; stdio?: 'inherit' };
    }> = [];

    const runCommand: CommandRunner = async (command, args, options) => {
      commandCalls.push({ command, args, options });
      return commandCalls.length === 1 ? 0 : 17;
    };

    const result = await runInteractiveInstallAndRestart({
      packageName: 'llm-usage-metrics',
      updateMessage: 'Update available.',
      env: { PATH: '/usr/bin' },
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily', '--json'],
      execPath: '/usr/bin/node',
      skipUpdateCheckEnvVar: 'LLM_USAGE_SKIP_UPDATE_CHECK',
      confirmInstall: vi.fn(async () => true),
      runCommand,
    });

    expect(result).toEqual({ continueExecution: false, exitCode: 17 });
    expect(commandCalls).toHaveLength(2);

    expect(commandCalls[0].command).toMatch(/npm(?:\.cmd)?$/u);
    expect(commandCalls[0].args).toEqual(['install', '-g', 'llm-usage-metrics@latest']);
    expect(commandCalls[0].options?.stdio).toBe('inherit');

    expect(commandCalls[1].command).toBe('/usr/bin/node');
    expect(commandCalls[1].args).toEqual(['/app/dist/index.js', 'daily', '--json']);
    expect(commandCalls[1].options?.env?.PATH).toBe('/usr/bin');
    expect(commandCalls[1].options?.env?.LLM_USAGE_SKIP_UPDATE_CHECK).toBe('1');
  });

  it('defaults restart execPath to process.execPath when not provided', async () => {
    const commandCalls: Array<{
      command: string;
      args: string[];
      options?: { env?: NodeJS.ProcessEnv; stdio?: 'inherit' };
    }> = [];

    const runCommand: CommandRunner = async (command, args, options) => {
      commandCalls.push({ command, args, options });
      return 0;
    };

    const result = await runInteractiveInstallAndRestart({
      packageName: 'llm-usage-metrics',
      updateMessage: 'Update available.',
      env: {},
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily'],
      skipUpdateCheckEnvVar: 'LLM_USAGE_SKIP_UPDATE_CHECK',
      confirmInstall: vi.fn(async () => true),
      runCommand,
    });

    expect(result).toEqual({ continueExecution: false, exitCode: 0 });
    expect(commandCalls).toHaveLength(2);
    expect(commandCalls[1].command).toBe(process.execPath);
    expect(commandCalls[1].args).toEqual(['/app/dist/index.js', 'daily']);
  });

  it('treats non-yes default confirm answers as declines', async () => {
    question.mockResolvedValue('n');

    await expect(defaultConfirmInstall('Install now? ')).resolves.toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it('writes default notifications to stderr', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    defaultNotify('hello');

    expect(consoleErrorSpy).toHaveBeenCalledWith('hello');
  });
});
