import { Command } from 'commander';

import {
  createReportCommands,
  createRootDescription,
} from './report-definitions/report-definitions.js';

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

  return program;
}
