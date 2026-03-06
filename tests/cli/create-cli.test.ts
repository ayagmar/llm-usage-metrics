import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCli } from '../../src/cli/create-cli.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('createCli', () => {
  it('registers daily, weekly, monthly, efficiency, optimize, and trends commands', () => {
    const cli = createCli();

    expect(cli.name()).toBe('llm-usage');
    expect(cli.commands.map((command) => command.name())).toEqual([
      'daily',
      'weekly',
      'monthly',
      'efficiency',
      'optimize',
      'trends',
    ]);
  });

  it('includes output, pricing, and source filter flags on report commands', () => {
    const cli = createCli();
    const reportCommands = cli.commands.filter((command) =>
      ['daily', 'weekly', 'monthly'].includes(command.name()),
    );

    for (const command of reportCommands) {
      expect(command.options.some((option) => option.long === '--markdown')).toBe(true);
      expect(command.options.some((option) => option.long === '--per-model-columns')).toBe(true);
      expect(command.options.some((option) => option.long === '--pricing-url')).toBe(true);
      expect(command.options.some((option) => option.long === '--pricing-offline')).toBe(true);
      expect(command.options.some((option) => option.long === '--ignore-pricing-failures')).toBe(
        true,
      );
      expect(command.options.some((option) => option.long === '--opencode-db')).toBe(true);
      expect(command.options.some((option) => option.long === '--gemini-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--droid-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--source')).toBe(true);
      expect(command.options.some((option) => option.long === '--source-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--model')).toBe(true);
    }
  });

  it('configures optimize command with candidate-model and top flags', () => {
    const cli = createCli();
    const optimizeCommand = cli.commands.find((command) => command.name() === 'optimize');

    expect(optimizeCommand).toBeDefined();
    expect(optimizeCommand?.options.some((option) => option.long === '--candidate-model')).toBe(
      true,
    );
    expect(optimizeCommand?.options.some((option) => option.long === '--top')).toBe(true);
    expect(optimizeCommand?.options.some((option) => option.long === '--share')).toBe(true);
    expect(optimizeCommand?.options.some((option) => option.long === '--repo-dir')).toBe(false);
    expect(optimizeCommand?.options.some((option) => option.long === '--per-model-columns')).toBe(
      false,
    );
  });

  it('configures trends command without markdown, share, or per-model columns', () => {
    const cli = createCli();
    const trendsCommand = cli.commands.find((command) => command.name() === 'trends');

    expect(trendsCommand).toBeDefined();
    expect(trendsCommand?.options.some((option) => option.long === '--days')).toBe(true);
    expect(trendsCommand?.options.some((option) => option.long === '--metric')).toBe(true);
    expect(trendsCommand?.options.some((option) => option.long === '--by-source')).toBe(true);
    expect(trendsCommand?.options.some((option) => option.long === '--json')).toBe(true);
    expect(trendsCommand?.options.some((option) => option.long === '--markdown')).toBe(false);
    expect(trendsCommand?.options.some((option) => option.long === '--share')).toBe(false);
    expect(trendsCommand?.options.some((option) => option.long === '--per-model-columns')).toBe(
      false,
    );
  });

  it('configures efficiency command with repository outcome flags', () => {
    const cli = createCli();
    const efficiencyCommand = cli.commands.find((command) => command.name() === 'efficiency');

    expect(efficiencyCommand).toBeDefined();
    expect(efficiencyCommand?.options.some((option) => option.long === '--repo-dir')).toBe(true);
    expect(
      efficiencyCommand?.options.some((option) => option.long === '--include-merge-commits'),
    ).toBe(true);
    expect(efficiencyCommand?.options.some((option) => option.long === '--share')).toBe(true);
    expect(
      efficiencyCommand?.options.some((option) => option.long === '--ignore-pricing-failures'),
    ).toBe(true);
    expect(efficiencyCommand?.options.some((option) => option.long === '--per-model-columns')).toBe(
      false,
    );
  });

  it('runs daily command and prints terminal table output', async () => {
    const emptySessionsDir = await mkdtemp(path.join(os.tmpdir(), 'usage-cli-empty-'));
    tempDirs.push(emptySessionsDir);

    const cli = createCli();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await cli.parseAsync(
      [
        'daily',
        '--pi-dir',
        emptySessionsDir,
        '--codex-dir',
        emptySessionsDir,
        '--source',
        'pi,codex',
        '--timezone',
        'UTC',
      ],
      { from: 'user' },
    );

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleSpy.mock.calls[0]?.[0])).toContain('Period');
    consoleSpy.mockRestore();
  });

  it('renders help output with command and npx examples', () => {
    const cli = createCli();
    const help = cli.helpInformation();
    const compactHelp = help.replace(/\s+/gu, ' ');
    const dailyCommandHelp = cli.commands
      .find((command) => command.name() === 'daily')
      ?.helpInformation();
    const compactDailyCommandHelp = dailyCommandHelp?.replace(/\s+/gu, ' ');

    expect(compactHelp).toContain('Supported sources (5): pi, codex, gemini, droid, opencode');
    expect(compactHelp).toContain('Show daily usage report');
    expect(compactHelp).toContain('llm-usage <command> --help');
    expect(compactHelp).toContain('--source opencode --opencode-db /path/to/opencode.db');
    expect(compactHelp).toContain(
      'llm-usage daily --pi-dir /tmp/pi-sessions --gemini-dir /tmp/.gemini --droid-dir /tmp/droid-sessions',
    );
    expect(compactHelp).toContain('llm-usage efficiency weekly --repo-dir /path/to/repo --json');
    expect(compactHelp).toContain(
      'llm-usage optimize monthly --provider openai --candidate-model gpt-4.1 --candidate-model gpt-5-codex --json',
    );
    expect(compactHelp).toContain('llm-usage trends');
    expect(compactHelp).toContain('npx --yes llm-usage-metrics@latest daily');
    expect(compactDailyCommandHelp).toContain('after source/provider/date filters');
  });

  it('does not leak empty-array defaults for repeatable options in command help', () => {
    const cli = createCli();
    const dailyHelp = cli.commands.find((command) => command.name() === 'daily')?.helpInformation();
    const optimizeHelp = cli.commands
      .find((command) => command.name() === 'optimize')
      ?.helpInformation();

    expect(dailyHelp).toBeDefined();
    expect(optimizeHelp).toBeDefined();
    expect(dailyHelp).not.toContain('(default: [])');
    expect(optimizeHelp).not.toContain('(default: [])');
  });

  it('supports --version output', async () => {
    const cli = createCli({ version: '1.2.3' });
    let output = '';

    cli.exitOverride();
    cli.configureOutput({
      writeOut: (value) => {
        output += value;
      },
      writeErr: (value) => {
        output += value;
      },
    });

    await expect(cli.parseAsync(['--version'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.version',
    });
    expect(output.trim()).toBe('1.2.3');
  });
});
