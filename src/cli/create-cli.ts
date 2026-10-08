import { Command } from 'commander';

import { setLogLevel } from '../utils/logger.js';
import { suggestClosest } from '../utils/suggest-closest.js';
import {
  createReportCommands,
  createRootDescription,
  GRANULARITY_ARGUMENT_VALUES,
  SUMMARY_COMMAND_NAME,
} from './report-definitions/report-definitions.js';
import { createConfigCommand } from './create-config-command.js';
import { createMachineCommand } from './create-machine-command.js';
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

  return program;
}
