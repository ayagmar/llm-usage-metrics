import { Command } from 'commander';

import { formatHelpExamples } from './report-definitions/report-definitions.js';
import { runMachineExport, type MachineExportCommandOptions } from './run-machine-export.js';

export function createMachineCommand(): Command {
  const machineCommand = new Command('machine')
    .description('Combine usage from your other machines')
    .addHelpText('after', formatHelpExamples(['llm-usage machine export > usage.ndjson']));
  const exportCommand = new Command('export')
    .description(
      "Print the usage this machine's reports count, as a versioned NDJSON bundle that machine sync reads",
    )
    .option(
      '--known <path>',
      'Leave out files already held at the same revision, as listed in this JSON file (- for stdin)',
    )
    .option('--quiet', 'Suppress informational stderr output (warnings still print)')
    .option(
      '--verbose',
      'Print detailed diagnostics on stderr (per-source counts, routine skips, config, env)',
    )
    .addHelpText('after', formatHelpExamples(['llm-usage machine export > usage.ndjson']))
    .action((options: MachineExportCommandOptions) => runMachineExport(options));

  machineCommand.addCommand(exportCommand);
  return machineCommand;
}
