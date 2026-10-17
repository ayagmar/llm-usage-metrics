import { Command, Help, Option } from 'commander';

import { setLogLevel } from '../utils/logger.js';
import { suggestClosest } from '../utils/suggest-closest.js';
import {
  createReportCommands,
  createRootDescription,
  GRANULARITY_ARGUMENT_VALUES,
  SUMMARY_COMMAND_NAME,
} from './report-definitions/report-definitions.js';
import { revealHiddenOptions } from './report-definitions/shared-report-options.js';
import { createConfigCommand } from './create-config-command.js';
import { createMachineCommand, createSyncCommand } from './create-machine-command.js';
import { createCompletionCommand, COMPLETION_SHELLS } from './create-completion-command.js';
import { createSchemaCommand, schemaNames } from './create-schema-command.js';

export type CreateCliOptions = {
  version?: string;
};

function getLongFlags(command: Command | undefined): string[] {
  return (command?.options ?? []).flatMap((option) => (option.long ? [option.long] : []));
}

/**
 * The summary runs for a bare `llm-usage`, so report options typed there land on it.
 * Point those to a report instead of commander's nearest-flag guess (`--since` →
 * `--source`).
 */
function rejectUnknownOption(program: Command, args: readonly string[]): never {
  const flag = args[0].split('=')[0];
  const summaryFlags = getLongFlags(program.commands.find(isSummaryCommand));
  const dailyFlags = getLongFlags(program.commands.find((command) => command.name() === 'daily'));
  // `llm-usage --since 2026-01-01 weekly`: the command word came after its options.
  const typedCommand = program.commands.find((command) => args.includes(command.name()));

  if (typedCommand) {
    const options = args.filter((arg) => arg !== typedCommand.name()).join(' ');
    program.error(
      `error: options go after the command, e.g. llm-usage ${typedCommand.name()} ${options}`,
    );
  }

  if (dailyFlags.includes(flag)) {
    program.error(
      `error: the summary has no ${flag} option; use a report, e.g. llm-usage daily ${args.join(' ')}`,
    );
  }

  const summarySuggestion = suggestClosest(flag, summaryFlags);
  const dailySuggestion = suggestClosest(flag, dailyFlags);
  const hint = summarySuggestion
    ? `\n(Did you mean ${summarySuggestion}?)`
    : dailySuggestion
      ? `\n(Did you mean llm-usage daily ${dailySuggestion}?)`
      : '';

  return program.error(`error: unknown option '${flag}'${hint}`);
}

function isSummaryCommand(command: Command): boolean {
  return command.name() === SUMMARY_COMMAND_NAME;
}

function rejectUnknownCommand(program: Command, args: readonly string[]): void {
  if (args.length === 0) {
    return;
  }

  if (args[0].startsWith('-')) {
    rejectUnknownOption(program, args);
  }

  const unknownCommand = args[0];
  const commandNames = [...program.commands.map((command) => command.name()), 'help'];

  // Options before a real command word go to the default summary command, which then
  // receives the command word as an argument (`llm-usage --json daily`).
  if (commandNames.includes(unknownCommand)) {
    program.error(`error: options go after the command, e.g. llm-usage ${unknownCommand} --json`);
  }

  const suggestion = suggestClosest(unknownCommand, commandNames);
  const hint = suggestion ? `\n(Did you mean ${suggestion}?)` : '';
  program.error(`error: unknown command '${unknownCommand}'${hint}`);
}

/**
 * Commander leaves option descriptions unwrapped when fewer than 40 columns remain beside
 * the flags, which on terminals under ~73 columns prints 200-character lines. There, each
 * flag goes on its own line with its description wrapped below it; wider terminals keep
 * commander's side-by-side layout.
 */
const SIDE_BY_SIDE_MIN_DESCRIPTION_WIDTH = 40;
const STACKED_DESCRIPTION_INDENT = '      ';

function formatHelpItem(
  this: Help,
  term: string,
  termWidth: number,
  description: string,
  helper: Help,
): string {
  const helpWidth = this.helpWidth ?? 80;
  const sideBySideWidth = helpWidth - termWidth - 4;

  if (!description || sideBySideWidth >= SIDE_BY_SIDE_MIN_DESCRIPTION_WIDTH) {
    return Help.prototype.formatItem.call(this, term, termWidth, description, helper);
  }

  const wrappedDescription = helper.boxWrap(
    description,
    helpWidth - STACKED_DESCRIPTION_INDENT.length,
  );

  return [
    `  ${term}`,
    ...wrappedDescription.split('\n').map((line) => `${STACKED_DESCRIPTION_INDENT}${line}`),
  ].join('\n');
}

function wrapHelpOnNarrowTerminals(command: Command): void {
  // boxWrap skips widths under minWidthToWrap; stacked descriptions are narrower than 40.
  command.configureHelp({ minWidthToWrap: 20, formatItem: formatHelpItem });

  for (const subcommand of command.commands) {
    wrapHelpOnNarrowTerminals(subcommand);
  }
}

/**
 * `--help-all` prints a command's help with its hidden options revealed: the per-source
 * path flags of the report commands. The docs tell users to type it on any command, so
 * commands that do not declare it get it too, left out of their help since there it
 * prints the usual help.
 */
function addHelpAllOption(command: Command): void {
  if (!command.options.some((option) => option.long === '--help-all')) {
    command.addOption(new Option('--help-all', 'Display help for command').hideHelp());
  }

  command.on('option:help-all', () => {
    revealHiddenOptions(command);
    command.help();
  });

  if (command.commands.length > 0) {
    command.enablePositionalOptions();
  }

  for (const subcommand of command.commands) {
    addHelpAllOption(subcommand);
  }
}

export function createCli(options: CreateCliOptions = {}): Command {
  const program = new Command();

  program
    .name('llm-usage')
    .description(createRootDescription())
    .version(options.version ?? '0.0.0')
    .showHelpAfterError();

  for (const command of createReportCommands()) {
    const isSummary = isSummaryCommand(command);

    if (isSummary) {
      // As the default command the summary receives any unknown command word or option,
      // so it reports them itself instead of commander's "too many arguments" or
      // nearest-flag guess.
      command
        .allowExcessArguments(true)
        .allowUnknownOption(true)
        .hook('preAction', (summaryCommand) => {
          rejectUnknownCommand(program, summaryCommand.args);
        });
    }

    // A bare `llm-usage` runs the summary instead of printing help.
    program.addCommand(command, { isDefault: isSummary });
  }
  program.addCommand(createConfigCommand());
  program.addCommand(createMachineCommand());
  program.addCommand(createSyncCommand());
  program.addCommand(createSchemaCommand());
  program.addCommand(
    createCompletionCommand(() => program, {
      efficiency: GRANULARITY_ARGUMENT_VALUES,
      optimize: GRANULARITY_ARGUMENT_VALUES,
      schema: schemaNames,
      completion: COMPLETION_SHELLS,
    }),
  );

  program.hook('preAction', (_thisCommand, actionCommand) => {
    const { quiet, verbose } = actionCommand.opts<{ quiet?: boolean; verbose?: boolean }>();

    if (quiet === true && verbose === true) {
      program.error('error: choose either --quiet or --verbose, not both');
    }

    if (quiet === true) {
      setLogLevel('warn');
    } else if (verbose === true) {
      setLogLevel('debug');
    }
  });

  // Every parent passes the rest of the line to the subcommand it names, so a group
  // sees `config init --help-all` as `init --help-all`, not as its own `--help-all`.
  program.enablePositionalOptions();
  for (const command of program.commands) {
    addHelpAllOption(command);
  }

  wrapHelpOnNarrowTerminals(program);

  return program;
}
