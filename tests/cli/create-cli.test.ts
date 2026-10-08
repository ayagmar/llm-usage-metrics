import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCli } from '../../src/cli/create-cli.js';
import { logger, setLogLevel } from '../../src/utils/logger.js';
import {
  getCliReferenceExamples,
  getReportDefinitionMetas,
} from '../../src/cli/report-definitions/report-definitions.js';
import { getSourceOverrideOptions } from '../../src/sources/create-default-adapters.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function getLongFlags(command: Command | undefined): string[] {
  return (command?.options ?? []).flatMap((option) => (option.long ? [option.long] : []));
}

describe('createCli', () => {
  it('registers summary, daily, weekly, monthly, compare, efficiency, optimize, trends, session, wrapped, events, statusline, doctor, prune, config, machine, sync, schema, and completion commands', () => {
    const cli = createCli();

    expect(cli.name()).toBe('llm-usage');
    expect(cli.commands.map((command) => command.name())).toEqual([
      'summary',
      'daily',
      'weekly',
      'monthly',
      'compare',
      'efficiency',
      'optimize',
      'trends',
      'session',
      'wrapped',
      'events',
      'statusline',
      'doctor',
      'prune',
      'config',
      'machine',
      'sync',
      'schema',
      'completion',
    ]);
  });

  // Which shared and command flags each command has, and which it must not have.
  it.each([
    {
      command: 'daily',
      present: [
        '--markdown',
        '--per-model-columns',
        '--pricing-url',
        '--pricing-offline',
        '--ignore-pricing-failures',
        '--source',
        '--source-dir',
        '--model',
        '--history',
        '--machine',
        '--by-machine',
        '--claude-dir',
        '--opencode-db',
      ],
      absent: [],
    },
    {
      command: 'optimize',
      present: ['--candidate-model', '--top', '--share', '--history'],
      absent: ['--repo-dir', '--per-model-columns'],
    },
    {
      command: 'trends',
      present: [
        '--days',
        '--metric',
        '--by-source',
        '--json',
        '--share',
        '--history',
        '--markdown',
      ],
      absent: ['--per-model-columns'],
    },
    {
      command: 'session',
      present: [
        '--top',
        '--id',
        '--by-repo',
        '--json',
        '--markdown',
        '--source',
        '--since',
        '--until',
        '--timezone',
        '--provider',
        '--model',
        '--pricing-url',
        '--history',
      ],
      absent: ['--share', '--per-model-columns', '--repo-dir'],
    },
    {
      command: 'compare',
      present: [
        '--vs-since',
        '--vs-until',
        '--json',
        '--markdown',
        '--since',
        '--until',
        '--provider',
        '--model',
        '--history',
        '--share',
      ],
      absent: ['--per-model-columns'],
    },
    {
      command: 'wrapped',
      present: [
        '--year',
        '--json',
        '--share',
        '--source',
        '--timezone',
        '--provider',
        '--model',
        '--history',
        '--markdown',
      ],
      absent: ['--since', '--until', '--per-model-columns'],
    },
    {
      command: 'efficiency',
      present: ['--repo-dir', '--include-merge-commits', '--share', '--ignore-pricing-failures'],
      absent: ['--per-model-columns'],
    },
    {
      command: 'doctor',
      present: ['--json', '--source', '--source-dir', '--pi-dir', '--opencode-db', '--goose-db'],
      absent: [
        '--markdown',
        '--since',
        '--timezone',
        '--provider',
        '--model',
        '--pricing-url',
        '--history',
        '--share',
        '--machine',
      ],
    },
    {
      command: 'prune',
      present: [
        '--suppressed',
        '--departed-before',
        '--apply',
        '--json',
        '--source',
        '--source-dir',
      ],
      absent: ['--history', '--since', '--timezone', '--pricing-url'],
    },
  ])('gives $command its flags', ({ command, present, absent }) => {
    const flags = getLongFlags(
      createCli().commands.find((candidate) => candidate.name() === command),
    );

    expect(present.filter((flag) => !flags.includes(flag))).toEqual([]);
    expect(absent.filter((flag) => flags.includes(flag))).toEqual([]);
  });

  it('registers dedicated source override flags in the frozen manifest order', () => {
    const cli = createCli();
    const dailyCommand = cli.commands.find((command) => command.name() === 'daily');
    const expectedFlags = getSourceOverrideOptions().map((option) => option.flag.split(' ')[0]);
    const registeredDedicatedFlags = (dailyCommand?.options ?? [])
      .map((option) => option.long)
      .filter((long): long is string => long !== undefined && expectedFlags.includes(long));

    expect(registeredDedicatedFlags).toEqual([
      '--pi-dir',
      '--codex-dir',
      '--copilot-dir',
      '--gemini-dir',
      '--droid-dir',
      '--claude-dir',
      '--openclaw-dir',
      '--opencode-db',
      '--goose-db',
      '--amp-dir',
      '--qwen-dir',
      '--kimi-dir',
      '--cline-dir',
      '--roocode-dir',
      '--kilocode-dir',
      '--antigravity-dir',
      '--dsh-dir',
    ]);
  });

  it('includes quiet on every report command', () => {
    const cli = createCli();
    const reportCommands = cli.commands.filter(
      (command) => !['config', 'machine', 'sync', 'schema', 'completion'].includes(command.name()),
    );

    for (const command of reportCommands) {
      expect(command.options.some((option) => option.long === '--quiet')).toBe(true);
      expect(command.options.some((option) => option.long === '--verbose')).toBe(true);
    }
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
      'Supported sources (17): pi, codex, gemini, droid, opencode, openclaw, claude, copilot, goose, amp, qwen, kimi, cline, roocode, kilocode, antigravity, dsh',
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
    expect(compactHelp).toContain('llm-usage compare');
    expect(compactHelp).toContain('llm-usage wrapped');
    expect(compactHelp).toContain('llm-usage doctor');
    expect(compactHelp).toContain('llm-usage prune --suppressed');
    expect(compactHelp).toContain('npx --yes llm-usage-metrics@latest');
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

  it('ends each command help with a short examples block', () => {
    const cli = createCli();

    // The text commander prints for --help, including addHelpText blocks.
    const fullHelp = (command: Command | undefined): string => {
      let text = '';
      command?.configureOutput({ writeOut: (chunk) => (text += chunk) }).outputHelp();
      return text;
    };

    for (const command of cli.commands.flatMap((entry) => [entry, ...entry.commands])) {
      expect(fullHelp(command), command.name()).toContain('Examples:\n  $ ');
    }

    const dailyHelp = fullHelp(cli.commands.find((command) => command.name() === 'daily'));
    const dailyExamples = dailyHelp.slice(dailyHelp.indexOf('Examples:'));
    expect(dailyExamples).not.toContain('--help');
    // The four shortest, so the long path-flag examples stay in the CLI reference only.
    expect(dailyExamples.match(/ {2}\$ .*/gu)).toEqual([
      '  $ llm-usage daily',
      '  $ llm-usage daily --json',
      '  $ llm-usage daily --markdown',
      '  $ llm-usage daily --compact',
    ]);
  });

  it('exports shared report metadata and CLI reference examples', () => {
    expect(getReportDefinitionMetas().map((meta) => meta.commandName)).toEqual([
      'summary',
      'daily',
      'weekly',
      'monthly',
      'compare',
      'efficiency',
      'optimize',
      'trends',
      'session',
      'wrapped',
      'events',
      'statusline',
      'doctor',
      'prune',
    ]);
    expect(getCliReferenceExamples()).toContain('llm-usage');
    expect(getCliReferenceExamples()).toContain('llm-usage trends');
    expect(getCliReferenceExamples()).toContain('llm-usage events --format jsonl > events.jsonl');
    expect(getCliReferenceExamples()).toContain('llm-usage compare');
    expect(getCliReferenceExamples()).toContain(
      'llm-usage compare --since 2026-06-01 --until 2026-06-30 --vs-since 2026-05-01 --vs-until 2026-05-31',
    );
    expect(getCliReferenceExamples()).toContain('llm-usage session --top 5 --json');
    expect(getCliReferenceExamples()).toContain('llm-usage monthly --no-history --pricing-offline');
    expect(getCliReferenceExamples()).toContain('llm-usage wrapped --year 2026 --share');
    expect(getCliReferenceExamples()).toContain('llm-usage doctor --json');
    expect(getCliReferenceExamples()).toContain('llm-usage statusline');
    expect(getCliReferenceExamples()).toContain('llm-usage prune --suppressed');
    expect(getCliReferenceExamples()).toContain(
      'llm-usage prune --departed-before 2026-01-01 --apply',
    );
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

  function captureOutput(cli: ReturnType<typeof createCli>): { text: () => string } {
    let output = '';
    cli.exitOverride();
    cli.configureOutput({
      writeOut: (value) => {
        output += value;
      },
      writeErr: (value) => {
        output += value;
      },
      outputError: (value) => {
        output += value;
      },
    });
    return { text: () => output };
  }

  function stubSummaryAction(cli: ReturnType<typeof createCli>) {
    const summaryAction = vi.fn();
    cli.commands.find((command) => command.name() === 'summary')?.action(summaryAction);
    return summaryAction;
  }

  it('runs the summary when no command is given', async () => {
    const cli = createCli();
    captureOutput(cli);
    const summaryAction = stubSummaryAction(cli);

    await cli.parseAsync([], { from: 'user' });
    await cli.parseAsync(['--json', '--source', 'codex'], { from: 'user' });

    expect(summaryAction).toHaveBeenCalledTimes(2);
    expect(summaryAction.mock.calls[1]?.[0]).toMatchObject({ json: true, source: ['codex'] });
  });

  it('reports an unknown command with a suggestion instead of running the summary', async () => {
    const cli = createCli();
    const output = captureOutput(cli);
    const summaryAction = stubSummaryAction(cli);

    await expect(cli.parseAsync(['dialy'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(summaryAction).not.toHaveBeenCalled();
    expect(output.text()).toContain("error: unknown command 'dialy'\n(Did you mean daily?)");
  });

  it('points a report option given to the bare command at a report', async () => {
    const cli = createCli();
    const output = captureOutput(cli);
    const summaryAction = stubSummaryAction(cli);

    await expect(cli.parseAsync(['--since', '2026-01-01'], { from: 'user' })).rejects.toMatchObject(
      { exitCode: 1 },
    );

    expect(summaryAction).not.toHaveBeenCalled();
    expect(output.text()).toContain(
      'error: the summary has no --since option; use a report, e.g. llm-usage daily --since 2026-01-01',
    );
    expect(output.text()).not.toContain('--source?');
  });

  it('keeps the command a user typed after a report option in the example', async () => {
    const cli = createCli();
    const output = captureOutput(cli);
    stubSummaryAction(cli);

    await expect(
      cli.parseAsync(['--since', '2026-01-01', 'weekly'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(output.text()).toContain(
      'error: options go after the command, e.g. llm-usage weekly --since 2026-01-01',
    );
  });

  it('suggests a close summary or report flag for a mistyped root option', async () => {
    const summaryTypo = createCli();
    const summaryOutput = captureOutput(summaryTypo);
    stubSummaryAction(summaryTypo);
    await expect(summaryTypo.parseAsync(['--jsno'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 1,
    });

    const reportTypo = createCli();
    const reportOutput = captureOutput(reportTypo);
    stubSummaryAction(reportTypo);
    await expect(
      reportTypo.parseAsync(['--sinse', '2026-01-01'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 1 });

    const unknown = createCli();
    const unknownOutput = captureOutput(unknown);
    stubSummaryAction(unknown);
    await expect(unknown.parseAsync(['--zzz'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(summaryOutput.text()).toContain(
      "error: unknown option '--jsno'\n(Did you mean --json?)",
    );
    expect(reportOutput.text()).toContain(
      "error: unknown option '--sinse'\n(Did you mean llm-usage daily --since?)",
    );
    expect(unknownOutput.text()).toContain("error: unknown option '--zzz'");
    expect(unknownOutput.text()).not.toContain('Did you mean');
  });

  it('hides the per-source path flags from --help and lists them with --help-all', async () => {
    async function readDailyHelp(flag: string): Promise<string> {
      const cli = createCli();
      const daily = cli.commands.find((command) => command.name() === 'daily');

      if (!daily) {
        throw new Error('daily command missing');
      }

      // Subcommands copy exit and output settings when added, so set them on daily itself.
      const output = captureOutput(daily);
      await expect(daily.parseAsync([flag], { from: 'user' })).rejects.toMatchObject({
        exitCode: 0,
      });
      return output.text();
    }

    const help = await readDailyHelp('--help');
    const helpAll = await readDailyHelp('--help-all');

    expect(help).not.toMatch(/^ {2}--claude-dir <path>/mu);
    expect(help).toContain('--source-dir');
    expect(help).toContain('listed by --help-all');

    for (const option of getSourceOverrideOptions()) {
      expect(helpAll).toContain(`  ${option.flag}`);
    }
    expect(helpAll).not.toContain('listed by --help-all');
  });

  it('still suggests a hidden path flag for a typo and keeps it hidden afterwards', async () => {
    const cli = createCli();
    const daily = cli.commands.find((command) => command.name() === 'daily');

    if (!daily) {
      throw new Error('daily command missing');
    }

    const output = captureOutput(daily);
    await expect(daily.parseAsync(['--claud-dir', '/x'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(output.text()).toContain(
      "error: unknown option '--claud-dir'\n(Did you mean --claude-dir?)",
    );
    expect(daily.options.find((option) => option.long === '--claude-dir')?.hidden).toBe(true);
  });

  it('accepts repeated directory flags and keeps database flags single', async () => {
    const cli = createCli();
    captureOutput(cli);
    const dailyAction = vi.fn();
    cli.commands.find((command) => command.name() === 'daily')?.action(dailyAction);

    await cli.parseAsync(
      ['daily', '--claude-dir', '/a', '--claude-dir', '/b', '--opencode-db', '/c.db'],
      { from: 'user' },
    );

    expect(dailyAction.mock.calls[0]?.[0]).toMatchObject({
      claudeDir: ['/a', '/b'],
      opencodeDb: '/c.db',
    });
  });

  it('explains option order when options precede a command', async () => {
    const cli = createCli();
    const output = captureOutput(cli);
    const summaryAction = stubSummaryAction(cli);

    await expect(cli.parseAsync(['--json', 'daily'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 1,
    });

    expect(summaryAction).not.toHaveBeenCalled();
    expect(output.text()).toContain(
      'error: options go after the command, e.g. llm-usage daily --json',
    );
    expect(output.text()).not.toContain('Did you mean');
  });

  it('offers --all on daily and weekly only', () => {
    const cli = createCli();
    const commandsWithAll = cli.commands
      .filter((command) => command.options.some((option) => option.long === '--all'))
      .map((command) => command.name());

    expect(commandsWithAll).toEqual(['daily', 'weekly']);
  });

  it('rejects --quiet together with --verbose', async () => {
    const cli = createCli();
    const output = captureOutput(cli);
    const summaryAction = stubSummaryAction(cli);

    await expect(
      cli.parseAsync(['summary', '--quiet', '--verbose'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(summaryAction).not.toHaveBeenCalled();
    expect(output.text()).toContain('choose either --quiet or --verbose, not both');
  });

  it.each([
    [['--verbose'], ['debug', 'info', 'warn']],
    [[], ['info', 'warn']],
    [['--quiet'], ['warn']],
  ])('maps %j to the stderr levels a report prints', async (flags, expectedLevels) => {
    const cli = createCli();
    captureOutput(cli);
    const printed: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((value: unknown) => {
      printed.push(String(value));
    });
    cli.commands
      .find((command) => command.name() === 'summary')
      ?.action(() => {
        logger.debug('debug line');
        logger.info('info line');
        logger.warn('warn line');
      });

    try {
      await cli.parseAsync(['summary', ...flags], { from: 'user' });
    } finally {
      errorSpy.mockRestore();
      setLogLevel('info');
    }

    expect(
      ['debug', 'info', 'warn'].filter((level) =>
        printed.some((line) => line.includes(`${level} line`)),
      ),
    ).toEqual(expectedLevels);
  });
});
