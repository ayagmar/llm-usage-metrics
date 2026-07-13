import { Command } from 'commander';

import { setLogLevel } from '../utils/logger.js';
import {
  createReportCommands,
  createRootDescription,
} from './report-definitions/report-definitions.js';
import { createConfigCommand } from './create-config-command.js';
import { createSchemaCommand } from './create-schema-command.js';

export type CreateCliOptions = {
  version?: string;
};

export function createCli(options: CreateCliOptions = {}): Command {
  const program = new Command();

  program
    .name('llm-usage')
    .description(createRootDescription())
    .version(options.version ?? '0.0.0')
    .showHelpAfterError();

  for (const command of createReportCommands()) {
    program.addCommand(command);
  }
  program.addCommand(createConfigCommand());
  program.addCommand(createSchemaCommand());

  program.hook('preAction', (_thisCommand, actionCommand) => {
    if (actionCommand.opts().quiet === true) {
      setLogLevel('warn');
    }
  });

  return program;
}
