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
import { getSourceOverrideOptions } from '../../src/cli/source-cli-options.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

const sourcePathFlags = getSourceOverrideOptions().map((option) => option.flag.split(' ')[0]);
const usageReportFlags = [
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
  '--by-repo',
  '--repo',
  '--last',
  '--no-cost',
  ...sourcePathFlags,
];

/** The usage-profile flags projects, blocks and value keep, beside their own. */
const rollupReportFlags = [
  '--json',
  '--markdown',
  '--source',
  '--since',
  '--until',
  '--timezone',
  '--provider',
  '--model',
  '--cost-mode',
  '--history',
  '--machine',
  '--no-sync',
  '--repo',
  '--last',
  '--all',
  '--compact',
  '--no-cost',
  ...sourcePathFlags,
];

function getLongFlags(command: Command | undefined): string[] {
  return (command?.options ?? []).flatMap((option) => (option.long ? [option.long] : []));
}

describe('createCli', () => {
  it('registers the report commands, then config, machine, sync, schema, and completion', () => {
    const cli = createCli();

    expect(cli.name()).toBe('llm-usage');
    expect(cli.commands.map((command) => command.name())).toEqual([
      'summary',
      'hourly',
      'daily',
      'weekly',
      'monthly',
      'projects',
      'compare',
      'efficiency',
      'optimize',
      'trends',
      'session',
      'blocks',
      'value',
      'wrapped',
      'events',
      'pricing',
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
    { command: 'daily', present: usageReportFlags, absent: [] },
    { command: 'weekly', present: usageReportFlags, absent: [] },
    { command: 'monthly', present: usageReportFlags, absent: [] },
    {
      command: 'hourly',
      present: [
        '--by-repo',
        '--repo',
        '--by-machine',
        '--compact',
        '--no-cost',
        '--last',
        '--per-model-columns',
        '--json',
        '--markdown',
        '--since',
        '--history',
        '--no-sync',
        ...sourcePathFlags,
      ],
      absent: ['--all', '--share', '--no-open'],
    },
    {
      command: 'projects',
      present: [...rollupReportFlags, '--granularity', '--top'],
      absent: ['--share', '--no-open', '--per-model-columns', '--by-repo', '--by-machine'],
    },
    {
      command: 'blocks',
      present: [...rollupReportFlags, '--top'],
      absent: ['--share', '--no-open', '--per-model-columns', '--by-repo', '--by-machine'],
    },
    {
      command: 'value',
      present: [...rollupReportFlags, '--plan', '--plan-price'],
      absent: ['--share', '--no-open', '--per-model-columns', '--by-repo', '--by-machine'],
    },
    {
      // Explains prices only: no usage is read, so no source, date or cost flags.
      command: 'pricing',
      present: [
        '--pricing-url',
        '--pricing-overrides',
        '--pricing-offline',
        '--json',
        '--markdown',
        '--quiet',
      ],
      absent: [
        '--source',
        '--source-dir',
        '--help-all',
        '--verbose',
        '--since',
        '--timezone',
        '--model',
        '--ignore-pricing-failures',
        '--cost-mode',
        '--history',
        '--no-sync',
        '--share',
        ...sourcePathFlags,
      ],
    },
    {
      command: 'optimize',
      present: ['--candidate-model', '--top', '--share', '--history', '--repo'],
      absent: ['--repo-dir', '--per-model-columns', '--by-repo'],
    },
    {
      command: 'trends',
      present: [
        '--last',
        '--days',
        '--metric',
        '--by-source',
        '--by-repo',
        '--repo',
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
        '--repo',
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
        '--by-repo',
        '--repo',
        '--source',
        '--timezone',
        '--pricing-url',
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
        '--pricing-url',
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
      present: [
        '--repo-dir',
        '--repo',
        '--include-merge-commits',
        '--share',
        '--ignore-pricing-failures',
      ],
      absent: ['--per-model-columns', '--by-repo'],
    },
    {
      command: 'doctor',
      present: ['--json', '--source', '--source-dir', ...sourcePathFlags],
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
      // Export stream: --format replaces --json.
      command: 'events',
      present: [
        '--format',
        '--source',
        '--since',
        '--pricing-url',
        '--history',
        '--no-sync',
        '--repo',
      ],
      absent: ['--json', '--markdown', '--share', '--by-repo'],
    },
    {
      // Always offline and silent, and never syncs over ssh.
      command: 'statusline',
      present: ['--source', '--verbose', '--pricing-overrides', '--history', '--machine'],
      absent: [
        '--json',
        '--quiet',
        '--pricing-url',
        '--pricing-offline',
        '--no-sync',
        '--since',
        '--repo',
        '--by-repo',
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

  it('registers --share, --no-open and --redact together, only on the share commands', () => {
    const shareCommands = createCli()
      .commands.filter((command) => {
        const flags = getLongFlags(command);
        return ['--share', '--no-open', '--redact'].every((flag) => flags.includes(flag));
      })
      .map((command) => command.name())
      .sort();
    const anyShareFlag = createCli()
      .commands.filter((command) =>
        getLongFlags(command).some((flag) => ['--share', '--no-open', '--redact'].includes(flag)),
      )
      .map((command) => command.name())
      .sort();

    expect(shareCommands).toEqual([
      'compare',
      'daily',
      'efficiency',
      'monthly',
      'optimize',
      'summary',
      'trends',
      'weekly',
      'wrapped',
    ]);
    expect(anyShareFlag).toEqual(shareCommands);
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

  it('includes quiet on every report command except the always-silent statusline', () => {
    const cli = createCli();
    const reportCommands = cli.commands.filter(
      (command) =>
        !['config', 'machine', 'sync', 'schema', 'completion', 'statusline'].includes(
          command.name(),
        ),
    );

    for (const command of reportCommands) {
      expect(command.options.some((option) => option.long === '--quiet')).toBe(true);
      // pricing reads no usage, so it has no per-source diagnostics to show.
      expect(command.options.some((option) => option.long === '--verbose')).toBe(
        command.name() !== 'pricing',
      );
    }
  });

  it('runs daily command and prints terminal output', async () => {
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
    expect(String(consoleSpy.mock.calls[0]?.[0])).toContain(
      'No usage data found for the selected filters.',
    );
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

  it('fits every help line to a phone-width or narrow terminal', () => {
    const cli = createCli();
    const commands = cli.commands.flatMap((entry) => [entry, ...entry.commands]);

    for (const columns of [44, 60]) {
      for (const command of [cli, ...commands]) {
        let text = '';
        command
          .configureOutput({
            writeOut: (chunk) => (text += chunk),
            getOutHelpWidth: () => columns,
          })
          .outputHelp();

        // Example commands and the usage synopsis are meant to be copied whole, and one
        // word cannot be split.
        const overflowing = text
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('$ ') && !line.startsWith('Usage: '))
          .filter((line) => line.length > columns && line.trim().includes(' '));

        expect(overflowing, `${command.name()} at ${String(columns)}`).toEqual([]);
      }
    }
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
      'hourly',
      'daily',
      'weekly',
      'monthly',
      'projects',
      'compare',
      'efficiency',
      'optimize',
      'trends',
      'session',
      'blocks',
      'value',
      'wrapped',
      'events',
      'pricing',
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

  it('points --json on statusline and events to the command that has it', async () => {
    for (const [name, alternative] of [
      ['statusline', 'use llm-usage summary --json'],
      ['events', 'use --format jsonl'],
    ] as const) {
      const cli = createCli();
      const command = cli.commands.find((entry) => entry.name() === name);
      expect(command).toBeDefined();
      const output = captureOutput(command ?? cli);
      command?.action(vi.fn());

      await expect(cli.parseAsync([name, '--json'], { from: 'user' })).rejects.toMatchObject({
        exitCode: 1,
      });
      expect(output.text()).toContain(`error: --json is not supported for ${name}; ${alternative}`);
    }
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

  it('rejects --cost-mode with --no-cost and leaves the mode unset when not passed', async () => {
    const cli = createCli();
    const daily = cli.commands.find((command) => command.name() === 'daily');

    if (!daily) {
      throw new Error('daily command missing');
    }

    const output = captureOutput(daily);
    await expect(
      daily.parseAsync(['--no-cost', '--cost-mode', 'both'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(output.text()).toContain(
      "error: option '--no-cost' cannot be used with option '--cost-mode <mode>'",
    );

    const dailyAction = vi.fn();
    const accepting = createCli();
    captureOutput(accepting);
    accepting.commands.find((command) => command.name() === 'daily')?.action(dailyAction);
    await accepting.parseAsync(['daily', '--no-cost'], { from: 'user' });
    await accepting.parseAsync(['daily', '--cost-mode', 'explicit'], { from: 'user' });

    expect(dailyAction.mock.calls[0]?.[0]).toMatchObject({ cost: false });
    expect(dailyAction.mock.calls[0]?.[0]).not.toHaveProperty('costMode');
    expect(dailyAction.mock.calls[1]?.[0]).toMatchObject({ cost: true, costMode: 'explicit' });
  });

  function findCommand(cli: ReturnType<typeof createCli>, name: string): Command {
    const command = cli.commands.find((candidate) => candidate.name() === name);

    if (!command) {
      throw new Error(`${name} command missing`);
    }

    return command;
  }

  it('collects repeated --plan ids and rejects an unknown one with the plan ids', async () => {
    const cli = createCli();
    captureOutput(cli);
    const valueAction = vi.fn();
    findCommand(cli, 'value').action(valueAction);

    await cli.parseAsync(['value', '--plan', 'claude-pro', '--plan', 'chatgpt-plus'], {
      from: 'user',
    });
    await cli.parseAsync(['value'], { from: 'user' });

    expect(valueAction.mock.calls[0]?.[0]).toMatchObject({
      plan: ['claude-pro', 'chatgpt-plus'],
    });
    // No commander default: the value report applies its own, so a passed plan replaces it.
    expect(valueAction.mock.calls[1]?.[0]).not.toHaveProperty('plan');

    const value = findCommand(createCli(), 'value');
    const output = captureOutput(value);
    await expect(
      value.parseAsync(['--plan', 'claude-ultra'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(output.text()).toContain(
      'Allowed choices are claude-pro, claude-max-5x, claude-max-20x, chatgpt-go, chatgpt-plus, chatgpt-pro-100, chatgpt-pro-200, chatgpt-pro-500.',
    );
  });

  it('collects --repo values and limits --granularity to daily, weekly and monthly', async () => {
    const cli = createCli();
    captureOutput(cli);
    const projectsAction = vi.fn();
    findCommand(cli, 'projects').action(projectsAction);

    await cli.parseAsync(
      ['projects', '--repo', 'api,./web', '--repo', '(unattributed)', '--granularity', 'weekly'],
      { from: 'user' },
    );

    expect(projectsAction.mock.calls[0]?.[0]).toMatchObject({
      repo: ['api,./web', '(unattributed)'],
      granularity: 'weekly',
    });

    const projects = findCommand(createCli(), 'projects');
    const output = captureOutput(projects);
    await expect(
      projects.parseAsync(['--granularity', 'hourly'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(output.text()).toContain('Allowed choices are daily, weekly, monthly.');
  });

  it('passes every model name to pricing and requires at least one', async () => {
    const cli = createCli();
    captureOutput(cli);
    const pricingAction = vi.fn();
    findCommand(cli, 'pricing').action(pricingAction);

    await cli.parseAsync(['pricing', 'gpt-5', 'claude-sonnet-4-5', '--json'], { from: 'user' });

    expect(pricingAction.mock.calls[0]?.[0]).toEqual(['gpt-5', 'claude-sonnet-4-5']);
    expect(pricingAction.mock.calls[0]?.[1]).toMatchObject({ json: true });

    const pricing = findCommand(createCli(), 'pricing');
    const output = captureOutput(pricing);
    await expect(pricing.parseAsync([], { from: 'user' })).rejects.toMatchObject({
      exitCode: 1,
    });
    expect(output.text()).toContain("missing required argument 'model'");
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

  it('offers --all on daily, weekly, projects, blocks and value only', () => {
    const cli = createCli();
    const commandsWithAll = cli.commands
      .filter((command) => command.options.some((option) => option.long === '--all'))
      .map((command) => command.name());

    expect(commandsWithAll).toEqual(['daily', 'weekly', 'projects', 'blocks', 'value']);
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
