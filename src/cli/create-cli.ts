import { Command } from 'commander';

import { setLogLevel } from '../utils/logger.js';
import { suggestClosest } from '../utils/suggest-closest.js';
import {
  createReportCommands,
  createRootDescription,
  SUMMARY_COMMAND_NAME,
} from './report-definitions/report-definitions.js';
import { createConfigCommand } from './create-config-command.js';
import { createSchemaCommand } from './create-schema-command.js';

export type CreateCliOptions = {
  version?: string;
};

function rejectUnknownCommand(program: Command, args: readonly string[]): void {
  if (args.length === 0) {
    return;
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
    const isSummary = command.name() === SUMMARY_COMMAND_NAME;

    if (isSummary) {
      // As the default command the summary receives any unknown command word, so it
      // reports that word itself instead of commander's "too many arguments".
      command.allowExcessArguments(true).hook('preAction', (summaryCommand) => {
        rejectUnknownCommand(program, summaryCommand.args);
      });
    }

    // A bare `llm-usage` runs the summary instead of printing help.
    program.addCommand(command, { isDefault: isSummary });
  }
  program.addCommand(createConfigCommand());
  program.addCommand(createSchemaCommand());

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
