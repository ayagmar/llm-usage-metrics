import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCli } from '../../src/cli/create-cli.js';
import {
  getCliReferenceExamples,
  getReportDefinitionMetas,
} from '../../src/cli/report-definitions/report-definitions.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('createCli', () => {
  it('registers daily, weekly, monthly, efficiency, optimize, trends, session, wrapped, and doctor commands', () => {
    const cli = createCli();

    expect(cli.name()).toBe('llm-usage');
    expect(cli.commands.map((command) => command.name())).toEqual([
      'daily',
      'weekly',
      'monthly',
      'efficiency',
      'optimize',
      'trends',
      'session',
      'wrapped',
      'doctor',
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
      expect(command.options.some((option) => option.long === '--goose-db')).toBe(true);
      expect(command.options.some((option) => option.long === '--amp-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--qwen-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--kimi-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--cline-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--roocode-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--kilocode-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--antigravity-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--copilot-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--gemini-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--droid-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--claude-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--openclaw-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--source')).toBe(true);
      expect(command.options.some((option) => option.long === '--source-dir')).toBe(true);
      expect(command.options.some((option) => option.long === '--model')).toBe(true);
      expect(command.options.some((option) => option.long === '--history')).toBe(true);
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
    expect(optimizeCommand?.options.some((option) => option.long === '--history')).toBe(true);
    expect(optimizeCommand?.options.some((option) => option.long === '--repo-dir')).toBe(false);
    expect(optimizeCommand?.options.some((option) => option.long === '--per-model-columns')).toBe(
      false,
    );
  });

  it('configures trends command with share but without markdown or per-model columns', () => {
    const cli = createCli();
    const trendsCommand = cli.commands.find((command) => command.name() === 'trends');

    expect(trendsCommand).toBeDefined();
    expect(trendsCommand?.options.some((option) => option.long === '--days')).toBe(true);
    expect(trendsCommand?.options.some((option) => option.long === '--metric')).toBe(true);
    expect(trendsCommand?.options.some((option) => option.long === '--by-source')).toBe(true);
    expect(trendsCommand?.options.some((option) => option.long === '--json')).toBe(true);
    expect(trendsCommand?.options.some((option) => option.long === '--share')).toBe(true);
    expect(trendsCommand?.options.some((option) => option.long === '--history')).toBe(true);
    expect(trendsCommand?.options.some((option) => option.long === '--markdown')).toBe(false);
    expect(trendsCommand?.options.some((option) => option.long === '--per-model-columns')).toBe(
      false,
    );
  });

  it('configures session command with markdown and top but without share or per-model columns', () => {
    const cli = createCli();
    const sessionCommand = cli.commands.find((command) => command.name() === 'session');

    expect(sessionCommand).toBeDefined();
    expect(sessionCommand?.options.some((option) => option.long === '--top')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--id')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--by-repo')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--json')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--markdown')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--source')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--since')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--until')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--timezone')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--provider')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--model')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--pricing-url')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--history')).toBe(true);
    expect(sessionCommand?.options.some((option) => option.long === '--share')).toBe(false);
    expect(sessionCommand?.options.some((option) => option.long === '--per-model-columns')).toBe(
      false,
    );
    expect(sessionCommand?.options.some((option) => option.long === '--repo-dir')).toBe(false);
  });

  it('configures wrapped command with year and share but without date or model filters', () => {
    const cli = createCli();
    const wrappedCommand = cli.commands.find((command) => command.name() === 'wrapped');

    expect(wrappedCommand).toBeDefined();
    expect(wrappedCommand?.options.some((option) => option.long === '--year')).toBe(true);
    expect(wrappedCommand?.options.some((option) => option.long === '--json')).toBe(true);
    expect(wrappedCommand?.options.some((option) => option.long === '--share')).toBe(true);
    expect(wrappedCommand?.options.some((option) => option.long === '--source')).toBe(true);
    expect(wrappedCommand?.options.some((option) => option.long === '--timezone')).toBe(true);
    expect(wrappedCommand?.options.some((option) => option.long === '--pricing-url')).toBe(true);
    expect(wrappedCommand?.options.some((option) => option.long === '--history')).toBe(true);
    expect(wrappedCommand?.options.some((option) => option.long === '--since')).toBe(false);
    expect(wrappedCommand?.options.some((option) => option.long === '--until')).toBe(false);
    expect(wrappedCommand?.options.some((option) => option.long === '--provider')).toBe(false);
    expect(wrappedCommand?.options.some((option) => option.long === '--model')).toBe(false);
    expect(wrappedCommand?.options.some((option) => option.long === '--markdown')).toBe(false);
    expect(wrappedCommand?.options.some((option) => option.long === '--per-model-columns')).toBe(
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

  it('configures doctor command with only discovery and JSON shared flags', () => {
    const cli = createCli();
    const doctorCommand = cli.commands.find((command) => command.name() === 'doctor');

    expect(doctorCommand).toBeDefined();
    expect(doctorCommand?.options.some((option) => option.long === '--json')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--source')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--source-dir')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--pi-dir')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--copilot-dir')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--openclaw-dir')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--opencode-db')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--goose-db')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--amp-dir')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--qwen-dir')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--kimi-dir')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--cline-dir')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--roocode-dir')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--kilocode-dir')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--antigravity-dir')).toBe(true);
    expect(doctorCommand?.options.some((option) => option.long === '--markdown')).toBe(false);
    expect(doctorCommand?.options.some((option) => option.long === '--since')).toBe(false);
    expect(doctorCommand?.options.some((option) => option.long === '--timezone')).toBe(false);
    expect(doctorCommand?.options.some((option) => option.long === '--provider')).toBe(false);
    expect(doctorCommand?.options.some((option) => option.long === '--model')).toBe(false);
    expect(doctorCommand?.options.some((option) => option.long === '--pricing-url')).toBe(false);
    expect(doctorCommand?.options.some((option) => option.long === '--history')).toBe(false);
    expect(doctorCommand?.options.some((option) => option.long === '--share')).toBe(false);
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
        '--openclaw-dir',
        emptySessionsDir,
        '--source',
        'pi,codex,openclaw',
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

    expect(compactHelp).toContain(
      'Supported sources (16): pi, codex, gemini, droid, opencode, openclaw, claude, copilot, goose, amp, qwen, kimi, cline, roocode, kilocode, antigravity',
    );
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
    expect(compactHelp).toContain('llm-usage session');
    expect(compactHelp).toContain('llm-usage wrapped');
    expect(compactHelp).toContain('llm-usage doctor');
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

  it('exports shared report metadata and CLI reference examples', () => {
    expect(getReportDefinitionMetas().map((meta) => meta.commandName)).toEqual([
      'daily',
      'weekly',
      'monthly',
      'efficiency',
      'optimize',
      'trends',
      'session',
      'wrapped',
      'doctor',
    ]);
    expect(getCliReferenceExamples()).toContain('llm-usage trends');
    expect(getCliReferenceExamples()).toContain('llm-usage session --top 5 --json');
    expect(getCliReferenceExamples()).toContain('llm-usage monthly --history --pricing-offline');
    expect(getCliReferenceExamples()).toContain('llm-usage wrapped --year 2026 --share');
    expect(getCliReferenceExamples()).toContain('llm-usage doctor --json');
    expect(getCliReferenceExamples()).toContain(
      'llm-usage optimize monthly --provider openai --candidate-model gpt-4.1 --candidate-model gpt-5-codex --json',
    );
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
